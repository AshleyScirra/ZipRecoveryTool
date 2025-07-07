
import { PromiseThrottle } from "./promiseThrottle.js";

const MIN_FILE_HEADER_SIZE = 30;
const FILE_HEADER_SIGNATURE = 0x504B0304;		// note in big endian here
const DATA_DESCRIPTOR_SIGNATURE = 0x504B0708;	// note in big endian here

// For decoding filenames, assuming UTF-8 encoding and with fatal mode enabled
// so errors throw an exception causing the file entry to be skipped.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// Restrict how many extractions happen simultaneously to avoid thrashing.
const extractThrottle = new PromiseThrottle(8);

// Chosen output folder handle.
let folderHandle = null;

// Stats
let filesIdentified = 0;
let filesExtracted = 0;
let filesFinishedExtracting = 0;

// HTML elements and event handlers
const filePickerElem = document.getElementById("filepicker");
const pickFolderButtonElem = document.getElementById("pickfolder");
const startButtonElem = document.getElementById("start");
const logListElem = document.getElementById("logList");
const progressElem = document.getElementById("progress");
progressElem.style.display = "none";

// Enable start button when a file chosen
filePickerElem.addEventListener("change", e =>
{
	startButtonElem.removeAttribute("disabled");
});

// Remove disabled attribute from 'Pick output folder' button when the File System Access API is supported.
if (window.showDirectoryPicker)
	pickFolderButtonElem.removeAttribute("disabled");

// Picking output folder
pickFolderButtonElem.addEventListener("click", async () =>
{
	try {
		folderHandle = await window.showDirectoryPicker({
			mode: "readwrite"
		});
	}
	catch (err)
	{
		folderHandle = null;
		console.log("Exception in showDirectoryPicker: ", err);
	}
});

// Starting file recovery
startButtonElem.addEventListener("click", () =>
{
	const file = filePickerElem.files[0];
	if (!file)
	{
		AddLogMessage("No file picked");
		return;
	}

	RecoverFile(file);
});

function AddLogMessage(msg)
{
	logListElem.insertAdjacentHTML("beforeend", "<li>" + msg + "</li>");
}

/////////////////////////////////////////////////////
// File recovery
async function RecoverFile(file)
{
	// Clear log messages and reset stats
	logListElem.innerHTML = "";
	filesIdentified = 0;
	filesExtracted = 0;
	filesFinishedExtracting = 0;
	progressElem.style.display = "";
	progressElem.removeAttribute("value");		// show indeterminate progress until first update

	// Array of extraction promises to await
	const promises = [];

	// Show a special message if the chosen file is 0 bytes.
	if (file.size === 0)
	{
		AddLogMessage("<strong>Invalid file:</strong> the file size is 0 bytes. Sorry - there is no data to recover.");
		return;
	}
	else
	{
		AddLogMessage(`File size is ${file.size} bytes. Starting recovery.`)
	}

	// Read entire file as ArrayBuffer. This isn't very efficient for large files. Never mind.
	const arrayBuffer = await file.arrayBuffer();

	// Create a DataView to read the data
	const dataView = new DataView(arrayBuffer);

	// Scan entire file for file header signatures. Also detect if the entire file is just zeroes.
	let isAllZeroes = true;

	for (let i = 0, len = arrayBuffer.byteLength - MIN_FILE_HEADER_SIZE; i < len; /* increment in loop */)
	{
		const byteValue = dataView.getUint8(i);

		// Unset all zeroes flag if any nonzero byte found
		if (byteValue !== 0)
			isAllZeroes = false;

		// Found first byte of file signature header: check if all 4 bytes are present
		if (byteValue === 0x50)
		{
			const signature = dataView.getUint32(i, false);		// note read as big endian
			if (signature === FILE_HEADER_SIGNATURE)
			{
				// Looks like a file header signature. Try to recover a file from this offset.
				// TryRecoverFileEntry() returns the next index to search onwards from.
				filesIdentified++;
				i = TryRecoverFileEntry(dataView, i, promises);
			}
			else
			{
				// Not the full file header signature: keep looking.
				++i;
			}
		}
		else
		{
			// Not the beginning of a file header signature: keep looking.
			++i;
		}
	}

	// If we got through the entire file and it was all zero bytes, log a special message. This is something
	// that has been seen in the wild so is special-cased.
	if (isAllZeroes)
	{
		AddLogMessage(`<strong>Invalid file:</strong> this file consists entirely of zeroes. Sorry - this means there is no data to recover.`);
	}
	else
	{
		// Otherwise wait for all file extractions to complete, then log the finished message.
		AddLogMessage(`Finished scan. Waiting for extraction of ${filesExtracted} files to finish...`);

		progressElem.setAttribute("max", filesExtracted);

		await Promise.all(promises);

		AddLogMessage(`Finished. Identified ${filesIdentified} files and extracted ${filesExtracted} files.`);

		progressElem.style.display = "none";
	}
}

/////////////////////////////////////////////////////
// Recovery of individual file entry.
// Here 'i' points to a file signature header. If anything goes wrong, on the assumption this is a false positive,
// it returns the next byte to continue searching for another file signature header from there. If it succeeds in
// identifying a file it will return the offset of the end of the entry.
function TryRecoverFileEntry(dataView, i, promises)
{
	const totalSize = dataView.byteLength;

	// Read the bits of the file header we're interested in.
	const bitFlags = dataView.getUint16(i + 6, true);
	const compression = dataView.getUint16(i + 8, true);
	let compressedSize = dataView.getUint32(i + 18, true);
	let uncompressedSize = dataView.getUint32(i + 22, true);
	const fileNameLength = dataView.getUint16(i + 26, true);

	// Fully handling Zip64 entries is not yet supported, so show a diagnostic if encountering the special values
	// of the compressed/uncompressed sizes that indicates Zip64.
	if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF)
	{
		AddLogMessage(`Discovered a file entry at offset ${i} but its size indicates a Zip64 entry which is not yet fully supported. This probably won't extract correctly without special support so skipping this entry.`);
		return i + 1;
	}

	// Validate the filename length. If OK, attempt to read it.
	if (fileNameLength === 0)
	{
		AddLogMessage(`Discovered a file entry at offset ${i} but it has a filename length of 0, so skipping it.`);
		return i + 1;
	}
	if (i + 30 + fileNameLength > totalSize)
	{
		AddLogMessage(`Discovered a file entry at offset ${i} but its filename extends past the end of the zip file, so skipping it.`);
		return i + 1;
	}

	const filenameData = new Uint8Array(dataView.buffer, i + 30, fileNameLength);
	let filename;
	try {
		filename = textDecoder.decode(filenameData);
	}
	catch (err)
	{
		AddLogMessage(`Discovered a file entry at offset ${i} but en error occurred while decoding the filename as UTF-8, so skipping it.`);
		return i + 1;
	}

	// Validate the extra field length. If OK, attempt to read extra field entries.
	const extraFieldLength = dataView.getUint16(i + 28, true);
	if (i + 30 + fileNameLength + extraFieldLength > totalSize)
	{
		AddLogMessage(`Discovered a file entry at offset ${i} but its extra field data extends past the end of the zip file, so skipping it.`);
		return i + 1;
	}

	if (extraFieldLength >= 4)
	{
		// Iterate each extra field entry
		for (let j = i + 30 + fileNameLength, lenj = j + extraFieldLength; j < lenj; /* increment in loop */)
		{
			const efSig = dataView.getUint16(j, true);
			const efLength = dataView.getUint16(j + 2, true);

			if (j + 4 + efLength > lenj)
			{
				AddLogMessage(`File entry '${filename}' has bad extra field signature ${efSig}: length extends past extra field`);
				break;
			}

			// Read sizes from Zip64 extended information extra field if provided.
			if (efSig === 1)
			{
				uncompressedSize = Number(dataView.getBigUint64(j + 4, true));
				compressedSize = Number(dataView.getBigUint64(j + 12, true));
			}

			j += 4 + efLength;
		}
	}

	// If the file appears to have a zero size, check if flags bit 3 is set. If so that means the data descriptor must
	// follow the compressed data. The problem is we don't know how long the compressed data is though. However we can
	// scan through the compressed data looking for either the data descriptor signature, or something that appears to
	// be a correct entry for the compressed size given the position in the data. This could hit a false positive, but
	// the chance of this seems slim, so it seems like a good approach to identify the end of the compressed data if
	// there is nothing else to go on.
	const compressedDataStart = i + 30 + fileNameLength + extraFieldLength;

	if (uncompressedSize === 0)
	{
		if ((bitFlags & 0x08) !== 0)		// need to look for data descriptor
		{
			// Scan through compressed data looking for a data descriptor.
			// NOTE: in the Zip64 format the data descriptor uses 8 bytes for the sizes. This is not currently supported.
			// It looks like some zip libraries still use 4 byte sizes for files under 4 GB even when Zip64 support
			// is enabled, so only checking for the 4 byte sizes should work most of the time anyway.
			for (let d = compressedDataStart; d < totalSize - 4; ++d)
			{
				// See if the data descriptor signature is here. This is optional and so may never appear.
				const signature = dataView.getUint32(d, false);		// note read as big endian
				if (signature === DATA_DESCRIPTOR_SIGNATURE)
				{
					// Found signature: read off the compressed and uncompressed size 8 bytes ahead (for the signature
					// and CRC-32 fields).
					compressedSize = dataView.getUint32(d + 8, true);
					uncompressedSize = dataView.getUint32(d + 12, true);

					// Verify the compressed size matches what we expect, in case the signature occurred in the
					// data descriptor by chance.
					if (compressedSize === d - compressedDataStart)
					{
						promises.push(ExtractCompressedData(dataView, compressedDataStart, compressedSize, uncompressedSize, compression, filename));

						// Continue search for further file entries just past the data descriptor.
						return compressedDataStart + compressedSize + 16;
					}
				}

				// As we don't know if we'll ever find a data descriptor signature, also check if there is a valid
				// compressed size field here matching how far through the compressed data we've come. As this field
				// is at least 4 bytes in to the data descriptor (past the CRC-32 field), it means we did not already
				// find the signature. Therefore this code path assumes there is no signature in the data descriptor.
				// Also note this is not checked at the start, because it must come at least 4 bytes in.
				if (d !== compressedDataStart)
				{
					const actualCompressedDataSizeHere = d - compressedDataStart - 4;
					const readCompressedDataSize = dataView.getUint32(d, true);

					// Found the correct compressed data size here.
					if (actualCompressedDataSizeHere === readCompressedDataSize)
					{
						// Set the compressed size, and also read the uncompressed size only for diagnostic purposes.
						compressedSize = actualCompressedDataSizeHere;
						uncompressedSize = dataView.getUint32(d + 8, true);
					
						promises.push(ExtractCompressedData(dataView, compressedDataStart, compressedSize, uncompressedSize, compression, filename));

						// Continue search for further file entries just past the data descriptor.
						return compressedDataStart + compressedSize + 12;
					}
				}
			}

			AddLogMessage(`Failed to find data descriptor for entry '${filename}' from offset ${compressedDataStart} (${totalSize - compressedDataStart} bytes remaining to end of file). This entry has been skipped.`);
			return compressedDataStart;
		}
		else
		{
			AddLogMessage(`Entry '${filename}' appears to be a zero-byte file. It has been skipped.`);
			return compressedDataStart;
		}
	}
	else
	{
		// File header appears to specify valid sizes, so use those.
		promises.push(ExtractCompressedData(dataView, compressedDataStart, compressedSize, uncompressedSize, compression, filename));
		return compressedDataStart + compressedSize;
	}
}

async function ExtractCompressedData(dataView, offset, size, expectedUncompressedSize, compression, filename)
{
	filesExtracted++;

	// Verify the compressed data fits within the file. If it doesn't, truncate it and show a diagnostic.
	if (offset + size > dataView.byteLength)
	{
		AddLogMessage(`File entry '${filename}' data extends past the end of the zip file. Its data has been truncated from ${size} bytes to ${dataView.byteLength - offset} bytes.`);
		size = dataView.byteLength - offset;
	}

	// Throttle extraction to avoid too much simultaneous work
	await extractThrottle.Add(() => DoExtractCompressedData(dataView, offset, size, expectedUncompressedSize, compression, filename));

	// Update progress
	filesFinishedExtracting++;
	progressElem.value = filesFinishedExtracting;
}

async function DoExtractCompressedData(dataView, offset, size, expectedUncompressedSize, compression, filename)
{
	// Get Uint8Array representing compressed data
	const data = new Uint8Array(dataView.buffer, offset, size);

	// Compression mode 0 means no compression, so the data can be written out as-is.
	if (compression === 0)
	{
		await WriteFile(data, filename);
	}
	// Compression mode 8 means DEFLATE. Use a DecompressionStream with "deflate-raw" to decompress.
	else if (compression === 8)
	{
		const decompressionStream = new DecompressionStream("deflate-raw");
		const writer = decompressionStream.writable.getWriter();
		writer.write(data);
		writer.close();
		
		const blob = await new Response(decompressionStream.readable).blob();

		// Log a diagnostic if the decompressed size does not match what we found in the zip. This may not matter
		// but it may be a sign of a problem that causes incorrect extraction.
		if (blob.size !== expectedUncompressedSize)
		{
			AddLogMessage(`File '${filename}' expected uncompressed size ${expectedUncompressedSize} but got ${blob.size}. Presumably the uncompressed size specified in the zip file is incorrect.`);
		}

		// Write the decompressed data to the output folder
		await WriteFile(blob, filename);
	}
	// Other compression modes are not supported. Hopefully these are rare anyway.
	else
	{
		AddLogMessage(`File '${filename}' uses compression mode '${compression}' which is not supported. The file has been skipped.`);
	}
}

async function WriteFile(data, filename)
{
	if (!folderHandle)
		return;		// no output folder chosen (or File System Access not supported)

	// Normalize slashes in the filename, just in case
	filename = filename.replaceAll("\\", "/");

	// Read folder components of the path (all slash-separated elements apart from the last)
	// and follow down the subfolders, creating them as necessary.
	let subFolderHandle = folderHandle;

	const parts = filename.split("/");
	for (let i = 0, len = parts.length - 1; i < len; ++i)
	{
		subFolderHandle = await subFolderHandle.getDirectoryHandle(parts[i], { create: true });
	}

	// Create the file in the destination subfolder
	const fileHandle = await subFolderHandle.getFileHandle(parts.at(-1), { create: true });

	// Write the data to this file
	const fsWritable = await fileHandle.createWritable();	// keepExistingData defaults to false (starts with empty file)
	await fsWritable.write(data);
	await fsWritable.close();
}
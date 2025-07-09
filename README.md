# ZipRecoveryTool
A browser-based tool to recover corrupt ZIP files, by searching for file headers instead of reading the central directory. Therefore even if the central directory is damaged or entirely missing, or entire ranges of the file are corrupt, the tool should still be able to extract any remaining intact files that can be successfully read and decompressed.

**Use at your own risk.** This tool may or may not work. Some files may be completely unrecoverable. The files it does extract may still be corrupt, or may be truncated due to the tool having to make guesses about the size of files.

Find out more in the blog post [Recovering corrupt ZIP files](https://www.construct.net/en/blogs/ashleys-blog-2/recovering-corrupt-zip-files-1895).

## Recovery strategy

The tool's recovery strategy works roughly like this. Notably, it makes no attempt whatsoever to use the central directory, which most ZIP tools will refer to.

1. Scan through the file looking for the byte sequence 50 4B 03 04, indicating the start of a local file header.
2. When found, attempt to read the flags, compression, compressed size, uncompressed size, file name and extra fields from the entry. If anything goes wrong, it bails out and continues scanning.
3. The compressed data size is obtained from several possible sources, checked for in the following order. If no size can be established the file entry is skipped. Note the scanning modes make use of minimum possible file sizes based on the file extension
    1. The local file header compressed size, if specified there.
    2. The Zip64 extended information extra field, if provided.
    3. Scanning through the compressed data for a data descriptor signature followed by the correct compressed size. This has a low risk of false positive resulting in a truncated file.
    4. Scanning through the compressed data for a data descriptor with no signature, merely checking for the correct compressed size. This has a higher risk of false positive resulting in a truncated file.
4. The compressed data is then extracted to the user's chosen output folder. Note currently the only supported compression modes are 0 (no compression) and 8 (DEFLATE).

## Writing recoverable ZIP files

Do you develop a tool that writes ZIP files? Consider the following to ensure the ZIP files are more reliably recoverable.

- Write the correct compressed size in the local file header, either in the normal compressed size field, or in the Zip64 extended information extra field.
- Alternatively at least ensure that data descriptors include a signature, as it reduces the chance of a false positive matching on the compressed size alone, thereby reducing the chance of recovering a truncated file.

## Further work

This tool appears to already do a good job with corrupt ZIP files. Some potential future ideas to improve it are:

- Proper support for Zip64 or other variants - these haven't been thoroughly tested yet
- Review support for filenames and UTF-8 support - there appear to be quirks in the zip file format about how these are handled
- When encountering an unsupported compression mode, write the raw compressed data out anyway, so another tool could be used to decompress it
- When scanning for a data descriptors, to avoid false positives, keep searching further ahead in the file to see if there is another match later on. Ideally the point to search up to would be the next local file header that appears to be valid. Other ways to verify the compressed data looks valid are:
    - Refer to the CRC-32 field. However if the file is corrupt, this might not be reliable.
    - Attempt to decompress the data and see if it succeeds.
    - Attempt to decode the data, e.g. PNG decode if the file extension is .png, and see if it succeeds.
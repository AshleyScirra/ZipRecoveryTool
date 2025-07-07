const DEFAULT_MAX_PARALLEL = 16;

export class PromiseThrottle
{
	constructor(maxParallel = DEFAULT_MAX_PARALLEL)
	{
		this._maxParallel = maxParallel;
		this._queue = [];
		this._activeCount = 0;
	}
	
	Add(func)
	{
		return new Promise((resolve, reject) =>
		{
			this._queue.push({ func, resolve, reject });
			
			this._MaybeStartNext();
		});
	}
	
	_MaybeStartNext()
	{
		if (!this._queue.length)
			return;
		
		if (this._activeCount >= this._maxParallel)
			return;
		
		this._activeCount++;
		const job = this._queue.shift();
		
		job.func()
		.then(result =>
		{
			job.resolve(result);
			this._activeCount--;
			this._MaybeStartNext();
		})
		.catch(err =>
		{
			job.reject(err);
			this._activeCount--;
			this._MaybeStartNext();
		});
	}
};
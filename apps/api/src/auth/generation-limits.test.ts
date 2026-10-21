import { expect, it, vi } from 'vitest';
import { reserveGeneration } from './generation-limits.js';
const user = { suspended:false,generation_enabled:true,max_queued_jobs:null,daily_generation_limit:null };
it.each([{...user,suspended:true},{...user,generation_enabled:false}])('blocks restricted users',async restricted=>{
  const query=vi.fn().mockResolvedValue({rows:[restricted]});
  await expect(reserveGeneration({query} as never,'u',1)).rejects.toMatchObject({statusCode:403});
  expect(query).toHaveBeenCalledTimes(1);
});
it('enforces the active-job limit before reserving daily usage',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{...user,max_queued_jobs:2}]}).mockResolvedValueOnce({rows:[{count:'2'}]});
  await expect(reserveGeneration({query} as never,'u',1)).rejects.toMatchObject({statusCode:429,code:'queued_job_limit'});
  expect(query).toHaveBeenCalledTimes(2);
});
it('counts every requested batch output against the daily limit',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{...user,daily_generation_limit:10}]}).mockResolvedValueOnce({rows:[{submitted:'8'}]});
  await expect(reserveGeneration({query} as never,'u',3)).rejects.toMatchObject({statusCode:429,code:'daily_generation_limit'});
  expect(query).toHaveBeenCalledTimes(2);
});
it('locks admission and records usage even for unlimited accounts',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[user]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
  await reserveGeneration({query} as never,'u',4);
  expect(query.mock.calls[0]![0]).toContain('FOR UPDATE');
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('ON CONFLICT'),['u',4]);
});

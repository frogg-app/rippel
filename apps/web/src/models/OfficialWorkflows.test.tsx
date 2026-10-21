import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {OfficialWorkflows} from './OfficialWorkflows';
vi.mock('../lib/api',()=>({request:vi.fn()}));
import {request} from '../lib/api';
afterEach(()=>vi.resetAllMocks());
it('searches the installed library and checks exact companion files before import',async()=>{
 vi.mocked(request).mockResolvedValueOnce({version:'1.0.0',entries:[{name:'wan_i2v',title:'Wan image to video',description:'Animate an image.',models:['wan'],tags:['image-to-video']}]}).mockResolvedValueOnce({assessment:{status:'needs-files',reasons:['Missing video_vae.safetensors']},files:[{name:'video_vae.safetensors',directory:'vae'}],omitted:[]});
 render(<OfficialWorkflows backendId="backend" family="wan"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Wan image to video'}));fireEvent.click(screen.getByRole('button',{name:'Check requirements'}));
 expect(await screen.findByText('vae/video_vae.safetensors')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Import workflow'})).toBeDisabled();
 await waitFor(()=>expect(request).toHaveBeenCalledWith('/workflow-library/check',expect.objectContaining({body:expect.objectContaining({backendId:'backend',name:'wan_i2v',version:'1.0.0',capability:'img2vid',family:'wan'})})));
});

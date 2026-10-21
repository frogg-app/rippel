import { useEffect, useState } from 'react';
import type { JobKind } from '@comfy/shared';
import { request } from '../lib/api';
import { Dropdown } from '../components/Dropdown';
import styles from './ModelsPanels.module.css';
interface Entry { name: string; title: string; description: string; models: string[]; tags: string[] }
interface Check { assessment: { status: string; reasons: string[] }; files: { name: string; directory: string }[]; omitted: string[] }
const kinds = [{value:'txt2img',label:'Text to image'}, {value:'img2img',label:'Image to image'}, {value:'txt2vid',label:'Text to video'}, {value:'img2vid',label:'Image to video'}, {value:'upscale',label:'Upscale'}];
export function OfficialWorkflows({ backendId, family, sourceName }: { backendId: string | null; family: string | null; sourceName?: string }) {
 const [catalogue,setCatalogue]=useState<{version:string;entries:Entry[]} | null>(null);
 const [search,setSearch]=useState(sourceName ?? (family === 'Hugging Face' ? '' : family ?? ''));
 const [error,setError]=useState<string | null>(null);
 useEffect(()=>{if(!backendId)return;const controller=new AbortController();setCatalogue(null);setError(null);
 request<{version:string;entries:Entry[]}>(`/workflow-library?backendId=${encodeURIComponent(backendId)}`,{signal:controller.signal}).then(setCatalogue).catch(e=>{if(!controller.signal.aborted)setError(e.message)});
 return ()=>controller.abort();},[backendId]);
 const terms=search.toLowerCase().split(/\s+/).filter(Boolean);
 const shown=catalogue?.entries.filter(entry=>terms.every(term=>[entry.name,entry.title,entry.description,...entry.models,...entry.tags].join(' ').toLowerCase().includes(term))).sort((a,b)=>{const score=(entry:Entry)=>terms.filter(term=>[entry.name,entry.title,...entry.models,...entry.tags].join(' ').toLowerCase().includes(term)).length;return score(b)-score(a);}) ?? [];
 return <section className={styles.sheetSection} aria-label="Find official workflows">
  <h3 className={styles.sheetSectionTitle}>Find official workflows</h3>
  <p className={styles.sheetOptionDesc}>Text to video (txt2vid) starts from a prompt. Image to video (img2vid) starts from an image. A workflow must match the model’s architecture and input type; an image-to-video model does not automatically support text-to-video.</p>
  <p className={styles.sheetOptionDesc}>Search the workflow library installed on this backend. Check a workflow to see its exact model, VAE, LoRA, and encoder files and what still needs setup.</p>
  {!backendId ? <p>Choose a backend to browse its library.</p> : <>
   <input className={styles.workflowSearch} aria-label="Search official workflows" placeholder="Model, family, or workflow name" value={search} onChange={e=>setSearch(e.target.value)}/>
   {error && <p role="alert">{error}</p>}
   {!catalogue && !error && <p role="status">Loading workflow library…</p>}
   {catalogue && <p className={styles.sheetOptionDesc}>{shown.length} workflows · Library {catalogue.version}{!shown.length && ' · Try a shorter family name, such as Wan or LTX.'}</p>}
   <ul className={styles.sheetOptions}>{shown.slice(0,40).map(entry=><OfficialEntry key={entry.name} entry={entry} backendId={backendId} version={catalogue!.version} family={family}/>)}</ul>
   {shown.length>40 && <p>Narrow your search to see more matches.</p>}
  </>}
 </section>;
}
function OfficialEntry({entry,backendId,version,family}:{entry:Entry;backendId:string;version:string;family:string|null}) {
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false);
 const [capability,setCapability]=useState<JobKind>(entry.tags.some(tag => /image.to.video/i.test(tag)) ? 'img2vid' : entry.tags.some(tag => /text.to.video/i.test(tag)) ? 'txt2vid' : 'txt2img');
 const [base,setBase]=useState(family && family !== 'Hugging Face' ? family : entry.models[0] ?? '');
 const [check,setCheck]=useState<Check|null>(null),[error,setError]=useState<string|null>(null);
 const [importId,setImportId]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 const body={backendId,name:entry.name,version,capability,family:base};
 async function run(action:'check'|'import'|'test') {setBusy(true);setError(null);setMessage(null);try {
  if(action==='test'){await request(`/workflow-library/${importId}/test`,{method:'POST',body:{backendId}});setMessage('Test queued on this backend. The workflow becomes available after the test produces an output.');}
  else if(action==='import'){const result=await request<{imported:{id:string}}>(`/workflow-library/import`,{method:'POST',body});setImportId(result.imported.id);setMessage('Imported for setup. A successful test is required before generation.');}
  else {setCheck(await request<Check>('/workflow-library/check',{method:'POST',body}));}
 }catch(e){setError(e instanceof Error ? e.message : 'Could not check workflow.');}finally{setBusy(false);}}
 return <li className={styles.sheetOption}><div className={styles.sheetOptionBody}>
  <button className={styles.workflowHeading} type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{entry.title}</button>
  <p className={styles.sheetOptionDesc}>{entry.description}</p>
  {open && <div className={styles.workflowControls}>
   <p className={styles.sheetOptionDesc}>Declared models: {entry.models.join(', ') || 'Not specified'}</p>
   <label>Input task<Dropdown aria-label={`Input task for ${entry.title}`} disabled={busy||!!importId} value={capability} options={kinds} onChange={value=>{setCapability(value as JobKind);setCheck(null)}}/></label>
   <label>Model family<input disabled={busy||!!importId} value={base} onChange={e=>{setBase(e.target.value);setCheck(null)}}/></label>
   <button type="button" disabled={busy||!base||!!importId} onClick={()=>void run('check')}>Check requirements</button>
   {check && <><p>{check.assessment.status.replaceAll('-',' ')}. {check.assessment.reasons.join(' ')}</p>
    <ul>{check.files.map(file=><li key={`${file.directory}/${file.name}`}><span className="mono">{file.directory}/{file.name}</span> <a href={`/models?tab=discover&backend=${encodeURIComponent(backendId)}&q=${encodeURIComponent(file.name)}`}>Find download</a></li>)}</ul>
    {check.omitted.length>0 && <p>{check.omitted.join(' ')}</p>}
    {!importId && <button type="button" disabled={busy||!['untested','ready'].includes(check.assessment.status)} onClick={()=>void run('import')}>Import workflow</button>}
   </>}
   {importId && <button type="button" disabled={busy} onClick={()=>void run('test')}>Run test generation</button>}
   {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </div>}
 </div></li>;
}

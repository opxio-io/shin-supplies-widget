const NOTION_KEY = process.env.STUDY_NOTION_API_KEY || process.env.NOTION_API_KEY;
const COURSES_DB = process.env.STUDY_COURSES_DB || '6f229180-5b64-4928-8ca9-29ab1c6a8073';
const TASKS_DB = process.env.STUDY_TASKS_DB || '6713fdeb-1b64-4917-8d0a-7bab45d07bad';
const SESSIONS_DB = process.env.STUDY_SESSIONS_DB || 'a7f8b817-2ce6-481c-97e6-8bd52044e10f';
const CLASSES_DB = process.env.STUDY_CLASSES_DB || '4b001602-fddd-4585-a1c6-947d89a6cdb0';

const headers = () => ({ Authorization:`Bearer ${NOTION_KEY}`, 'Notion-Version':'2022-06-28', 'Content-Type':'application/json' });
async function queryAll(id){ let out=[],cursor; do{ const r=await fetch(`https://api.notion.com/v1/databases/${id}/query`,{method:'POST',headers:headers(),body:JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})})}); if(!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`); const j=await r.json(); out.push(...j.results); cursor=j.has_more?j.next_cursor:null; }while(cursor); return out; }
const text=p=>p?.title?.map(x=>x.plain_text).join('')||p?.rich_text?.map(x=>x.plain_text).join('')||'';
const select=p=>p?.select?.name||p?.status?.name||'';
const num=p=>p?.number??null;
const date=p=>p?.date||null;
const relation=p=>p?.relation?.map(x=>x.id)||[];
const checkbox=p=>!!p?.checkbox;
function course(x){const p=x.properties;return{id:x.id,name:text(p.Course),code:text(p.Code),type:select(p.Type),term:select(p.Term),professor:text(p.Professor),location:text(p.Location),targetGrade:num(p['Target Grade']),currentGrade:num(p['Current Grade']),active:checkbox(p.Active)};}
function task(x){const p=x.properties;return{id:x.id,name:text(p.Task),courseIds:relation(p.Course),type:select(p.Type),due:date(p.Due),status:select(p.Status),weight:num(p['Weight %']),estimatedHours:num(p['Estimated Hours']),difficulty:select(p.Difficulty),priority:select(p.Priority),studyStart:date(p['Study Start']),submitted:checkbox(p.Submitted),notes:text(p.Notes)};}
function session(x){const p=x.properties;return{id:x.id,name:text(p.Session),courseIds:relation(p.Course),taskIds:relation(p['Academic Task']),when:date(p.When),method:select(p['Study Method']),topic:text(p.Topic),plannedMinutes:num(p['Planned Minutes']),actualMinutes:num(p['Actual Minutes']),status:select(p.Status),focus:num(p['Focus / 5']),confidence:num(p['Confidence / 5']),completed:checkbox(p.Completed)};}
function cls(x){const p=x.properties;return{id:x.id,name:text(p.Class),courseIds:relation(p.Course),type:select(p.Type),when:date(p.When),location:text(p.Location),instructor:text(p.Instructor),week:num(p.Week),topic:text(p.Topic),preparation:text(p.Preparation),attended:checkbox(p.Attended)};}
export default async function handler(req,res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=600');if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='GET')return res.status(405).json({error:'GET only'});if(!NOTION_KEY)return res.status(500).json({error:'Missing STUDY_NOTION_API_KEY / NOTION_API_KEY'});try{const [c,t,s,l]=await Promise.all([queryAll(COURSES_DB),queryAll(TASKS_DB),queryAll(SESSIONS_DB),queryAll(CLASSES_DB)]);res.status(200).json({updatedAt:new Date().toISOString(),courses:c.map(course),tasks:t.map(task),sessions:s.map(session),classes:l.map(cls)});}catch(e){console.error('[study-hq]',e);res.status(503).json({error:e.message});}}

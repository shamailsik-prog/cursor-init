import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import fs from 'fs'
const ddl=fs.readFileSync('/workspace/audit/cursor-init/postgres/ddl/001_corpus_contract.sql','utf8').split('\n')
const sql=ddl.map((l,i)=>{const n=i+1; if(n===2) return 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;'; if(n===36) return "CREATE TABLE corpus_embeddings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), classification_rank SMALLINT); -- stub for pgvector table"; if(n>=37&&n<=38) return '-- skipped'; return l}).join('\n')
const p=new EmbeddedPostgres({databaseDir:'/tmp/epg/data',user:'postgres',password:'pw',port:55432,persistent:false})
await p.initialise(); await p.start()
const su=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:'pw',database:'postgres'}); await su.connect()
const out=[]
try{ await su.query(sql); out.push('DDL (minus pgvector lines 2-vector,36-38) applied OK') }catch(e){out.push('DDL ERROR '+e.message)}
const cols=(await su.query("select column_name from information_schema.columns where table_name='judgment'")).rows.map(r=>r.column_name)
out.push('judgment cols: '+cols.join(','))
await su.query("CREATE ROLE app_writer LOGIN PASSWORD 'x'; GRANT SELECT,INSERT,UPDATE ON judgment TO app_writer; GRANT SELECT ON classification_rank TO app_writer;")
// insert a privileged row as superuser with minimal required cols
const req=(await su.query("select column_name,data_type from information_schema.columns where table_name='judgment' and is_nullable='NO' and column_default is null")).rows
out.push('required cols: '+JSON.stringify(req))

await su.query("INSERT INTO judgment (id,case_title,classification,review_status) VALUES ('00000000-0000-0000-0000-000000000001','Probe v State','privileged','promoted')")
const w=new pg.Client({host:'127.0.0.1',port:55432,user:'app_writer',password:'x',database:'postgres'}); await w.connect()
try{ await w.query("UPDATE judgment SET classification='public' WHERE id='00000000-0000-0000-0000-000000000001'"); out.push('A plain downgrade: ALLOWED (unexpected)') }catch(e){ out.push('A plain downgrade by app_writer: REJECTED -> '+e.message) }
await w.query("SET app.declassify_reason = 'anything'")
try{ await w.query("UPDATE judgment SET classification='public' WHERE id='00000000-0000-0000-0000-000000000001'"); out.push('B app_writer after SET app.declassify_reason=anything: DOWNGRADE ALLOWED') }catch(e){ out.push('B rejected '+e.message) }
out.push('row now: '+JSON.stringify((await su.query("select classification from judgment")).rows))
out.push('declassify() exists: '+(await su.query("select count(*) from pg_proc where proname='declassify'")).rows[0].count)
await w.end()
fs.writeFileSync('/tmp/epg/out1.txt',out.join('\n'))
console.log(out.join('\n'))
await su.end(); await p.stop()

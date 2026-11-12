"""Full binary in isolated SQLite; fixtures only; credentials stay in memory."""
import importlib.util,pathlib,subprocess,tempfile,time,json,secrets,urllib.request,urllib.error,hashlib,socket,base64,io,zipfile,re,os
from urllib.parse import quote,urlencode
root=pathlib.Path(__file__).resolve().parents[2]
binary=os.environ.get('MOTEARY_BINARY',str(root/'build/moteary'))
s=importlib.util.spec_from_file_location('imp',root/'moteary/import_sources.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
import sys
sys.path.insert(0,str(root/'moteary'))
import import_long_text as longtext
results=[]
def check(name, ok, detail=None):
 results.append({'check':name,'passed':bool(ok),**({'detail':detail} if detail is not None else {})})
with tempfile.TemporaryDirectory(prefix='moteary-live-qa-') as d:
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();base=f'http://127.0.0.1:{port}'
 proc=subprocess.Popen([binary,'--addr','127.0.0.1','--port',str(port),'--data',d,'--config-apply','off'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  def req(route,body=None,token=None,method=None):
   headers={'Content-Type':'application/json'}
   if token:headers['Authorization']='Bearer '+token
   r=urllib.request.Request(base+route,None if body is None else json.dumps(body).encode(),headers,method=method)
   return urllib.request.urlopen(r,timeout=10)
  for _ in range(100):
   try:req('/api/instance/profile').close();break
   except Exception:time.sleep(.1)
  password=secrets.token_urlsafe(25);user='qa'+secrets.token_hex(5)
  created=json.load(req('/api/users',{'username':user,'password':password,'displayName':'Synthetic importer QA'}))
  token=json.load(req('/api/auth/signin',{'passwordCredentials':{'username':user,'password':password}}))['accessToken']
  client=m.Client(base,token)
  path=pathlib.Path(d)/'合成材料.md'; path.write_text('铜蓝咖啡 QA 资料。不是搬家计划。\n第一行\n第二行 😀',encoding='utf8');item=m.prepare(path,'reference','只用于隔离验收')
  first=client.ingest(item);second=client.ingest(item)
  check('MD import and idempotent retry',first['status']=='imported' and second['status']=='already-imported')
  memo=client.call('GET',first['name']);attachment=memo['attachments'][0]
  check('memo is PRIVATE',memo['visibility']=='PRIVATE')
  f='/file/'+attachment['name']+'/'+quote(attachment['filename'],safe='')
  mdZip=zipfile.ZipFile(io.BytesIO(req(f,token=token).read()))
  check('MD archived original exact byte SHA256',hashlib.sha256(mdZip.read(item['filename'])).hexdigest()==item['sha256'])
  for route,label in [('/api/'+memo['name'],'private memo'),(f,'private original')]:
   try:req(route).close();status=200
   except urllib.error.HTTPError as e:status=e.code
   check('anonymous cannot read '+label,status in (401,403,404),{'status':status})
  listed=client.call('GET','memos?'+urlencode({'filter':'content.contains("铜蓝咖啡") && tag in ["拾微"]'}))
  check('Chinese keyword and source tag retrieve original',any(x['name']==memo['name'] for x in listed.get('memos',[])))
  scoped='creator == '+json.dumps(created['name'])+' && tag in ["拾微"]'
  for term,category,expected,label in [
   ('铜蓝咖啡','reference',True,'Scoped Chinese search returns owned original'),
   ('铜蓝咖啡','work',False,'Category search does not leak other category'),
   ('missing") || true || ("','reference',False,'Quoted search cannot broaden CEL scope')]:
   query=scoped+' && tag in ['+json.dumps(category)+'] && content.contains('+json.dumps(term)+')'
   found=client.call('GET','memos?'+urlencode({'filter':query})).get('memos',[])
   check(label,any(x['name']==memo['name'] for x in found)==expected)
  ui_source=(root/'web/src/components/MotearyWorkspace/MotearyWorkspace.tsx').read_text()
  sort=re.search(r'orderBy:\s*"([^"]+)"',ui_source).group(1)
  try:
   listed=client.call('GET','memos?'+urlencode({'filter':'creator == '+json.dumps(created['name'])+' && tag in ["拾微"]','orderBy':sort}))
   check('UI exact account scoped list query',any(x['name']==memo['name'] for x in listed.get('memos',[])),{'orderBy':sort})
  except urllib.error.HTTPError as e:check('UI exact account scoped list query',False,{'orderBy':sort,'status':e.code})
  before_attachments=len(client.call('GET','attachments').get('attachments',[]))
  before_memos=len(client.call('GET','memos').get('memos',[]))
  large=pathlib.Path(d)/'oversized-chinese.txt';large.write_text('合成测试材料。'*1000,encoding='utf8')
  rejected=False
  try:client.ingest(m.prepare(large,'reference'))
  except ValueError as e:rejected='No file uploaded' in str(e) and '8192' in str(e)
  check('21KB Chinese memo rejected against real 8192-byte quota before upload',rejected)
  check('Quota rejection leaves attachment count unchanged',len(client.call('GET','attachments').get('attachments',[]))==before_attachments)
  check('Quota rejection leaves memo count unchanged',len(client.call('GET','memos').get('memos',[]))==before_memos)
  # Exercise actual browser guard code via Vitest, with REST-backed list transport.
  cross_env={**os.environ,'MOTEARY_CROSS_QA':json.dumps({'base':base,'token':token,'owner':created['name'],'sha256':item['sha256']})}
  cross_run=subprocess.run(['pnpm','exec','vitest','run','tests/moteary-batch.test.tsx','--maxWorkers','1','-t','uses actual REST service'],cwd=root/'web',env=cross_env,capture_output=True,text=True)
  check('Actual UI guard rejects previously CLI imported SHA',cross_run.returncode==0)
  gui_source=pathlib.Path(d)/'gui-original.txt';gui_source.write_text('仅GUI先导入的合成资料',encoding='utf8')
  gui_item=m.prepare(gui_source,'reference')
  gui_record=client.call('POST','memos?memoId=mui-crossentrysynthetic',{'content':gui_item['content'],'visibility':'PRIVATE'})
  counts_before=(len(client.call('GET','attachments').get('attachments',[])),len(client.call('GET','memos').get('memos',[])))
  blocked=False
  try:client.ingest(gui_item)
  except ValueError as e:blocked='Possible cross-entry' in str(e)
  counts_after=(len(client.call('GET','attachments').get('attachments',[])),len(client.call('GET','memos').get('memos',[])))
  check('CLI rejects possible UI-origin duplicate without claiming equivalence',blocked)
  check('Cross-entry conflict writes no memo or attachment',counts_before==counts_after)
  # Long-text explicit mode: interruption, resume, private search and original recovery.
  longitem=m.prepare(large,'reference')
  longplan=longtext.plan(longitem,8192)
  original_ingest=client.ingest
  seen=[0]
  def interrupt_ingest(record):
   seen[0]+=1
   if seen[0]==3: raise RuntimeError('synthetic interruption')
   return original_ingest(record)
  client.ingest=interrupt_ingest
  interrupted=False
  try:longtext.ingest_long(client,longitem)
  except RuntimeError as e:interrupted='Partial import: 2/' in str(e)
  client.ingest=original_ingest
  check('long text interruption reports partial state',interrupted)
  longresult=longtext.ingest_long(client,longitem)
  check('long text resume verifies prefix and completes remaining parts',longresult['status']=='complete' and longresult['records'][0]['status']=='already-imported' and longresult['records'][2]['status']=='imported')
  longretry=longtext.ingest_long(client,longitem)
  check('long text full retry creates no duplicate records',all(x['status']=='already-imported' for x in longretry['records']))
  longmemos=[client.call('GET',x['name']) for x in longresult['records']]
  check('long index and every part are private',all(x['visibility']=='PRIVATE' for x in longmemos))
  recovered=''.join(x['content'].split('## 分段原文\n',1)[1] for x in longmemos[1:])
  check('long chunks reconstruct exact UTF8 source without truncation',recovered.encode('utf8')==longitem['data'])
  la=longmemos[0]['attachments'][0]
  longfile='/file/'+la['name']+'/'+quote(la['filename'],safe='')
  with zipfile.ZipFile(io.BytesIO(req(longfile,token=token).read())) as z:
   check('long index archive preserves full original SHA256',hashlib.sha256(z.read(longitem['filename'])).hexdigest()==longitem['sha256'])
  found=client.call('GET','memos?'+urlencode({'filter':scoped+' && content.contains("合成测试材料")'})).get('memos',[])
  check('long text chunks retrievable with account scoped keyword',any(x['name']==longmemos[1]['name'] for x in found))
  # Batch CLI uses the real isolated service, not a mock.
  batch_files=[]
  for filename,kind,body in [('batch-diary.txt','diary','批量合成日记'),('batch-work.md','work','批量合成工作资料')]:
   source=pathlib.Path(d)/filename;source.write_text(body,encoding='utf8');batch_files.append({'file':filename,'kind':kind})
  manifest=pathlib.Path(d)/'batch.json';manifest.write_text(json.dumps(batch_files),encoding='utf8')
  batchenv={**os.environ,'MOTEARY_API_TOKEN':token}
  batchcmd=['python3',str(root/'moteary/import_batch.py'),str(manifest),'--base-url',base]
  receipt=pathlib.Path(d)/'batch-receipt.json'
  run=subprocess.run(batchcmd+['--receipt',str(receipt)],env=batchenv,capture_output=True,text=True)
  check('batch CLI first run exits successfully',run.returncode==0)
  saved=json.loads(receipt.read_text())['records']
  check('batch receipt has two confirmed imports',len(saved)==2 and all(x['status']=='imported' for x in saved))
  check('batch sources are actually PRIVATE',all(client.call('GET',x['name'])['visibility']=='PRIVATE' for x in saved))
  second_receipt=pathlib.Path(d)/'batch-retry.json'
  retry=subprocess.run(batchcmd+['--receipt',str(second_receipt)],env=batchenv,capture_output=True,text=True)
  check('batch retry revalidates remote originals',retry.returncode==0 and all(x['status']=='already-imported' for x in json.loads(second_receipt.read_text())['records']))
  check('batch receipts contain no credentials',token not in receipt.read_text() and token not in second_receipt.read_text())
  # A changed record halts retry, leaving subsequent inputs untouched.
  changed=client.call('GET',saved[0]['name'])
  client.call('PATCH',saved[0]['name']+'?updateMask=content',{'name':saved[0]['name'],'content':changed['content']+'\n手动修改'})
  third_receipt=pathlib.Path(d)/'batch-conflict.json'
  conflict=subprocess.run(batchcmd+['--receipt',str(third_receipt)],env=batchenv,capture_output=True,text=True)
  statuses=[x['status'] for x in json.loads(third_receipt.read_text())['records']]
  check('batch changed source stops without overwrite',conflict.returncode==1 and statuses==['needs-review','not-started'] and client.call('GET',saved[0]['name'])['content'].endswith('手动修改'))
  jpg=pathlib.Path(d)/'synthetic-original.jpg';jpg.write_bytes(base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/4QA0RXhpZgAATU0AKgAAAAgAAQEOAAIAAAASAAAAGgAAAABTWU5USEVUSUMgUUEgT05MWQD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpqKKK9o8Y/9k='))
  imageitem=m.prepare(jpg,'reference');result=client.ingest(imageitem);imageMemo=client.call('GET',result['name']);a=next(x for x in imageMemo['attachments'] if x['filename'].endswith('.original.zip'))
  downloaded=req('/file/'+a['name']+'/'+quote(a['filename'],safe=''),token=token).read()
  archive=zipfile.ZipFile(io.BytesIO(downloaded));original=archive.read(imageitem['filename'])
  check('JPEG archived original byte preservation',hashlib.sha256(original).hexdigest()==imageitem['sha256'],{'beforeBytes':len(imageitem['data']),'afterBytes':len(original),'archiveBytes':len(downloaded),'originalReportedSaved':result.get('processing',{}).get('original')})
  try:imageRetry=client.ingest(imageitem);check('JPEG idempotent retry',imageRetry['status']=='already-imported')
  except Exception as e:check('JPEG idempotent retry',False,{'error':type(e).__name__,'message':str(e)})
  raw=pathlib.Path(d)/'synthetic-unknown.bin';raw.write_bytes(jpg.read_bytes());rawitem=m.prepare(raw,'reference','未知扩展名合成测试');rawResult=client.ingest(rawitem);rawMemo=client.call('GET',rawResult['name']);rawAttachment=rawMemo['attachments'][0]
  rawBytes=req('/file/'+rawAttachment['name']+'/'+quote(rawAttachment['filename'],safe=''),token=token).read()
  if rawAttachment['filename'].endswith('.original.zip'):rawBytes=zipfile.ZipFile(io.BytesIO(rawBytes)).read(rawitem['filename'])
  check('Unknown-extension original byte preservation',hashlib.sha256(rawBytes).hexdigest()==rawitem['sha256'],{'beforeBytes':len(rawitem['data']),'afterBytes':len(rawBytes)})
  # Binary sources remain retrievable, not falsely searchable as parsed content.
  material_files=[]
  for filename,data in [('synthetic-paper.pdf',b'%PDF-1.4\nUNPARSED_PDF_MARKER\n%%EOF'),('synthetic-lecture.wav',b'RIFF'+b'UNTRANSCRIBED_AUDIO_MARKER'+b'WAVE')]:
   source=pathlib.Path(d)/filename;source.write_bytes(data)
   material=m.prepare(source,'reference','可检索的合成批注')
   saved_material=client.ingest(material);record=client.call('GET',saved_material['name'])
   check(filename+' is PRIVATE with not-run processing',record['visibility']=='PRIVATE' and saved_material['processing']['transcription']=='not-run' and saved_material['processing']['ocr']=='not-run')
   found=client.call('GET','memos?'+urlencode({'filter':scoped+' && content.contains('+json.dumps(filename)+')'})).get('memos',[])
   check(filename+' findable by saved filename',any(x['name']==record['name'] for x in found))
   check(filename+' no parsed body invented',data.decode() not in record['content'] and '未进行转写' in record['content'])
   marker='UNPARSED_PDF_MARKER' if filename.endswith('.pdf') else 'UNTRANSCRIBED_AUDIO_MARKER'
   hidden=client.call('GET','memos?'+urlencode({'filter':scoped+' && content.contains('+json.dumps(marker)+')'})).get('memos',[])
   check(filename+' binary internal marker not falsely searchable',not any(x['name']==record['name'] for x in hidden))
   a=record['attachments'][0];route='/file/'+a['name']+'/'+quote(a['filename'],safe='')
   with zipfile.ZipFile(io.BytesIO(req(route,token=token).read())) as z:check(filename+' exact original retrieved',z.read(filename)==data)
   material_files.append(route)
  other_password=secrets.token_urlsafe(25);other_user='qa'+secrets.token_hex(5)
  client.call('POST','users',{'username':other_user,'password':other_password,'displayName':'Other synthetic QA','role':'USER'})
  other_token=json.load(req('/api/auth/signin',{'passwordCredentials':{'username':other_user,'password':other_password}}))['accessToken']
  for route,label in [('/api/'+memo['name'],'memo'),(f,'original archive')]:
   try:req(route,token=other_token).close();status=200
   except urllib.error.HTTPError as e:status=e.code
   check('other account cannot read private '+label,status in (401,403,404),{'status':status})
  for route in material_files:
   try:req(route,token=other_token).close();status=200
   except urllib.error.HTTPError as e:status=e.code
   check('other account cannot fetch binary material archive',status in (401,403,404))
  for lm in longmemos:
   try:req('/api/'+lm['name'],token=other_token).close();status=200
   except urllib.error.HTTPError as e:status=e.code
   check('other account cannot read long record '+lm['name'],status in (401,403,404))
  try:req(longfile,token=other_token).close();status=200
  except urllib.error.HTTPError as e:status=e.code
  check('other account cannot download long original',status in (401,403,404))
  other_result=longtext.ingest_long(m.Client(base,other_token),longitem)
  check('other account can independently import identical long source',other_result['index']!=longresult['index'] and other_result['status']=='complete')
  exported=req('/file/users/'+user+'/export',token=token).read()
  with zipfile.ZipFile(io.BytesIO(exported)) as full_export:
   long_entries=[x for x in full_export.namelist() if x.endswith('/'+longitem['filename']+'.original.zip')]
   check('export contains full long original archive',len(long_entries)==1)
   if long_entries:
    with zipfile.ZipFile(io.BytesIO(full_export.read(long_entries[0]))) as z:
     check('exported long original exact bytes',z.read(longitem['filename'])==longitem['data'])
   original_entries=[x for x in full_export.namelist() if x.endswith('/'+item['filename']+'.original.zip')]
   check('upstream export includes original archive',len(original_entries)==1)
   if original_entries:
    with zipfile.ZipFile(io.BytesIO(full_export.read(original_entries[0]))) as nested:
     check('exported original exact SHA256',hashlib.sha256(nested.read(item['filename'])).hexdigest()==item['sha256'])
  proc.terminate();proc.wait(timeout=10)
  proc=subprocess.Popen([binary,'--addr','127.0.0.1','--port',str(port),'--data',d,'--config-apply','off'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   try:req('/api/instance/profile').close();break
   except Exception:time.sleep(.1)
  token=json.load(req('/api/auth/signin',{'passwordCredentials':{'username':user,'password':password}}))['accessToken'];client=m.Client(base,token)
  check('restart preserves exact original and replay identity',client.ingest(item)['status']=='already-imported')
  check('restart preserves archived JPEG and replay identity',client.ingest(imageitem)['status']=='already-imported')
  check('restart verifies complete long text and original',all(x['status']=='already-imported' for x in longtext.ingest_long(client,longitem)['records']))
  altered=longmemos[1]
  client.call('PATCH',altered['name']+'?updateMask=content',{'name':altered['name'],'content':altered['content']+'手动改动'})
  conflict=False
  try:longtext.ingest_long(client,longitem)
  except RuntimeError:conflict=True
  check('long text refuses to overwrite manual edits',conflict and client.call('GET',altered['name'])['content'].endswith('手动改动'))
  # Mutate synthetic private memo's visibility only, prove importer refuses changed scope.
  client.call('PATCH',memo['name']+'?updateMask=visibility',{'name':memo['name'],'visibility':'PUBLIC'})
  try:client.ingest(item);check('public scope mutation rejected on retry',False)
  except ValueError:check('public scope mutation rejected on retry',True)
 finally:
  proc.terminate();proc.wait(timeout=10)
out={'syntheticOnly':True,'tests':results,'passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results)}
if os.environ.get('MOTEARY_QA_OUTPUT'):pathlib.Path(os.environ['MOTEARY_QA_OUTPUT']).write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False,indent=2))
raise SystemExit(1 if out['failed'] else 0)

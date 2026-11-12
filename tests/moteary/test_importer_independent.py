import importlib.util, pathlib, tempfile, unittest
from urllib.request import Request, HTTPRedirectHandler
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading, zipfile, base64
from urllib.error import HTTPError
SRC=pathlib.Path(__file__).resolve().parents[2]/'moteary/import_sources.py'
s=importlib.util.spec_from_file_location('moteary_import',SRC); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class FakeClient(m.Client):
 def __init__(self, responses):
  super().__init__('http://127.0.0.1:5231','synthetic-not-a-real-token'); self.responses=list(responses); self.calls=[]
 def call(self,method,route,body=None):
  self.calls.append((method,route,body)); v=self.responses.pop(0)
  if isinstance(v,Exception): raise v
  return v
class IndependentImporter(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
  self.p=pathlib.Path(self.temp.name)/'合成资料.md'; self.p.write_text('拾微 QA 合成文本\n# 测试\n第二行 😀',encoding='utf-8'); self.item=m.prepare(self.p,'reference')
 def archive(self,data,filename=None,extra=False):
  b=BytesIO()
  with zipfile.ZipFile(b,'w') as z:
   z.writestr(filename or self.item['filename'],data)
   if extra:z.writestr('extra.txt',b'extra')
  return b.getvalue()
 def archived_client(self,blob):
  c=FakeClient([{'content':self.item['content'],'visibility':'PRIVATE','attachments':[{'name':'attachments/original','filename':self.item['filename']+'.original.zip'}]}])
  class Opener:
   def open(_,req,timeout):return BytesIO(blob)
  c.opener=Opener();return c
 def test_archive_extra_entry_rejected(self):
  with self.assertRaises(ValueError):self.archived_client(self.archive(self.item['data'],extra=True)).ingest(self.item)
 def test_archive_wrong_path_rejected(self):
  with self.assertRaises(ValueError):self.archived_client(self.archive(self.item['data'],filename='../original.md')).ingest(self.item)
 def test_archive_corrupt_container_rejected(self):
  with self.assertRaises(zipfile.BadZipFile):self.archived_client(b'not-a-zip').ingest(self.item)
 def test_archive_uncompressed_size_cap_rejected(self):
  b=BytesIO()
  with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr(self.item['filename'],b'a'*(16*1024*1024+1))
  with self.assertRaises(ValueError):self.archived_client(b.getvalue()).ingest(self.item)
 def test_all_uploads_archive_exact_original(self):
  c=FakeClient([HTTPError('synthetic',404,'missing',None,None),{'name':'attachments/original'},{'name':'memos/'+self.item['id']}]);c.ingest(self.item)
  payload=c.calls[1][2];self.assertEqual(payload['filename'],self.item['filename']+'.original.zip');self.assertEqual(payload['type'],'application/zip')
  with zipfile.ZipFile(BytesIO(base64.b64decode(payload['content']))) as z:
   self.assertEqual(z.namelist(),[self.item['filename']]);self.assertEqual(z.read(self.item['filename']),self.item['data'])
 def test_original_bytes_and_identity_stable(self):
  a=self.item; self.assertEqual(a['data'],self.p.read_bytes()); self.assertIn('第二行 😀',a['content']); self.assertEqual(a['id'],m.prepare(self.p,'reference')['id'])
 def test_no_network_during_prepare(self):
  a=m.prepare(self.p,'reference',source_url='https://synthetic.invalid/never-fetched'); self.assertIn('synthetic.invalid',a['content'])
 def test_symlink_rejected(self):
  p=self.p.with_suffix('.link'); p.symlink_to(self.p)
  with self.assertRaises(ValueError):m.prepare(p,'work')
 def test_remote_plain_http_rejected(self):
  with self.assertRaises(ValueError):m.Client('http://example.invalid','not-real')
 def test_create_is_private_and_keeps_attachment(self):
  c=FakeClient([HTTPError('synthetic',404,'missing',None,None),{'name':'attachments/original'},{'name':'memos/'+self.item['id']}]); result=c.ingest(self.item)
  self.assertEqual(result['status'],'imported'); self.assertEqual(c.calls[2][2]['visibility'],'PRIVATE'); self.assertEqual(c.calls[2][2]['attachments'],[{'name':'attachments/original'}])
 def test_403_not_misread_as_missing(self):
  c=FakeClient([HTTPError('synthetic',403,'forbidden',None,None)])
  with self.assertRaises(HTTPError):c.ingest(self.item)
  self.assertEqual(len(c.calls),1)
 def test_uncertain_write_never_deletes_original(self):
  c=FakeClient([HTTPError('synthetic',404,'missing',None,None),{'name':'attachments/original'},TimeoutError('unknown outcome')])
  with self.assertRaisesRegex(RuntimeError,'uncertain'):c.ingest(self.item)
  self.assertFalse(any(x[0]=='DELETE' for x in c.calls))
 def test_changed_existing_memo_rejected(self):
  c=FakeClient([{'content':'different','visibility':'PRIVATE','attachments':[{'name':'attachments/original'}]}])
  with self.assertRaises(ValueError):c.ingest(self.item)
 def test_existing_public_memo_must_not_report_private_success(self):
  c=FakeClient([{'content':self.item['content'],'visibility':'PUBLIC','attachments':[{'name':'attachments/original'}]}])
  with self.assertRaises(ValueError):c.ingest(self.item)
 def test_existing_unrelated_attachment_must_not_claim_original_saved(self):
  c=FakeClient([{'content':self.item['content'],'visibility':'PRIVATE','attachments':[{'name':'attachments/wrong','filename':'different.bin','size':'1'}]}])
  with self.assertRaises(ValueError):c.ingest(self.item)
 def test_no_redirect_for_any_status(self):
  req=Request('https://chosen.invalid/api/memos/x',headers={'Authorization':'Bearer synthetic-not-a-real-token'})
  for code in (301,302,303,307,308):
   with self.subTest(code=code):
    with self.assertRaises(ValueError):m.NoRedirect().redirect_request(req,None,code,'Found',{},'https://different.invalid/collect')
 def test_real_http_redirect_never_reaches_other_origin(self):
  received=[]
  class Destination(BaseHTTPRequestHandler):
   def do_GET(inner):
    received.append(inner.headers.get('Authorization'));inner.send_response(200);inner.end_headers();inner.wfile.write(b'{}')
   def log_message(*args):pass
  target=ThreadingHTTPServer(('127.0.0.1',0),Destination)
  class Redirector(BaseHTTPRequestHandler):
   def do_GET(inner):
    inner.send_response(302);inner.send_header('Location',f'http://127.0.0.1:{target.server_port}/collect');inner.end_headers()
   def log_message(*args):pass
  source=ThreadingHTTPServer(('127.0.0.1',0),Redirector)
  threads=[threading.Thread(target=x.serve_forever,daemon=True) for x in (source,target)]
  for thread in threads:thread.start()
  try:
   with self.assertRaises(ValueError):m.Client(f'http://127.0.0.1:{source.server_port}','synthetic-token').call('GET','probe')
   self.assertEqual(received,[])
  finally:
   for server in (source,target):server.shutdown();server.server_close()
   for thread in threads:thread.join()
 def test_existing_original_download_integrity(self):
  c=FakeClient([{'content':self.item['content'],'visibility':'PRIVATE','attachments':[{'name':'attachments/original','filename':self.item['filename']+'.original.zip'}]}])
  class Opener:
   def open(_,req,timeout):return BytesIO(self.archive(self.item['data']))
  c.opener=Opener()
  self.assertEqual(c.ingest(self.item)['status'],'already-imported'); self.assertEqual(len(c.calls),1)
 def test_same_filename_wrong_bytes_rejected(self):
  c=FakeClient([{'content':self.item['content'],'visibility':'PRIVATE','attachments':[{'name':'attachments/original','filename':self.item['filename']+'.original.zip'}]}])
  class Opener:
   def open(_,req,timeout):return BytesIO(self.archive(b'changed bytes'))
  c.opener=Opener()
  with self.assertRaises(ValueError):c.ingest(self.item)
  self.assertEqual(len(c.calls),1)
 def test_missing_attachment_does_not_recreate_existing_memo(self):
  c=FakeClient([{'content':self.item['content'],'visibility':'PRIVATE','attachments':[{'name':'attachments/original','filename':self.item['filename']+'.original.zip'}]},{'name':'attachments/accidental-new-upload'},ValueError('already exists')])
  class Opener:
   def open(_,req,timeout):raise HTTPError('synthetic',404,'missing file',None,None)
  c.opener=Opener()
  with self.assertRaises(Exception):c.ingest(self.item)
  self.assertEqual([x[0] for x in c.calls],['GET'],'A missing file must not be mistaken for a missing memo')
if __name__=='__main__':unittest.main(verbosity=2)

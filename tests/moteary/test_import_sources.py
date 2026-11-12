import importlib.util, pathlib, tempfile, unittest
p=pathlib.Path(__file__).parents[2]/'moteary/import_sources.py'
s=importlib.util.spec_from_file_location('import_sources',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class ImportContract(unittest.TestCase):
 def test_contract(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'讲座.txt'; p.write_text('不是所有灵感都要变成任务。',encoding='utf-8')
   a=m.prepare(p,'lecture'); b=m.prepare(p,'lecture')
   self.assertEqual(a['id'],b['id']); self.assertIn('不是所有',a['content'])
   self.assertNotEqual(a['id'],m.prepare(p,'work')['id'])
   self.assertNotEqual(a['id'],m.prepare(p,'lecture','我的想法')['id'])
 def test_privacy(self):
  for host in ['http://example.com','https://user:secret@example.com','file:///tmp/x']:
   with self.assertRaises(ValueError): m.Client(host,'unused')
 def test_no_directory(self):
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaises(ValueError): m.prepare(d,'work')
class QuotaPreflight(unittest.TestCase):
 def test_quota_failure_never_writes(self):
  from urllib.error import HTTPError
  calls=[]
  client=m.Client('http://127.0.0.1:5231','synthetic')
  def call(method,route,body=None):
   calls.append((method,route))
   if route.startswith('memos/'): raise HTTPError('',404,'missing',{},None)
   if route=='auth/me': return {'user': {'name':'users/qa'}}
   raise RuntimeError('quota temporarily unavailable')
  client.call=call
  with self.assertRaises(RuntimeError):client.ingest({'id':'synthetic'})
  self.assertFalse(any(method=='POST' for method,_ in calls))
 def test_missing_limits_never_writes(self):
  from urllib.error import HTTPError
  calls=[]
  client=m.Client('http://127.0.0.1:5231','synthetic')
  def call(method,route,body=None):
   calls.append((method,route))
   if route.startswith('memos/'): raise HTTPError('',404,'missing',{},None)
   if route=='auth/me': return {'user': {'name':'users/qa'}}
   return {}
  client.call=call
  with self.assertRaises(ValueError):client.ingest({'id':'synthetic'})
  self.assertFalse(any(method=='POST' for method,_ in calls))
if __name__=='__main__': unittest.main()

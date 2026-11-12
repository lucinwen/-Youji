import unittest,sys,pathlib,tempfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'moteary'))
from import_sources import prepare
from import_long_text import plan

class LongTextPlan(unittest.TestCase):
 def item(self,text):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'synthetic.txt';p.write_bytes(text.encode('utf8'));return prepare(p,'reference')
 def test_exact_multibyte_reconstruction(self):
  text=('中文😀\r\n\t'*1800)+'end'
  records=plan(self.item(text),8192)
  recovered=''.join(x['content'].split('## 分段原文\n',1)[1] for x in records[1:])
  self.assertEqual(recovered,text)
  self.assertIn('](/memos/'+records[0]['id']+')',records[1]['content'])
  self.assertIn('](/memos/'+records[1]['id']+')',records[0]['content'])
  self.assertTrue(all(len(x['content'].encode())<=8192 for x in records))
 def test_quota_change_does_not_change_identity(self):
  item=self.item('中文'*6000)
  self.assertEqual(plan(item,8192),plan(item,10000))
 def test_account_isolated_ids(self):
  item=self.item('字'*5000)
  a=plan(item,8192,'users/a');b=plan(item,8192,'users/b')
  self.assertFalse(set(x['id'] for x in a)&set(x['id'] for x in b))
 def test_small_quota_fails_before_writes(self):
  with self.assertRaises(ValueError):plan(self.item('字'*4000),1024)
 def test_size_bound(self):
  with self.assertRaises(ValueError):plan(self.item('a'*(256*1024+1)),8192)
 def test_empty_rejected(self):
  with self.assertRaises(ValueError):plan(self.item(''),8192)
 def test_max_size_index_fits_default_quota(self):
  records=plan(self.item('a'*(256*1024)),8192)
  self.assertEqual(len(records),65)
  self.assertEqual(records[0]['data'],b'a'*(256*1024))
if __name__=='__main__':unittest.main()

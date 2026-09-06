import sys, pathlib
HELMET = pathlib.Path('_helmet.txt').read_text()
TPL = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
{helmet}
{body}
</x-dc>
</body>
</html>
"""
for p in sys.argv[1:]:
    name = pathlib.Path(p).name.replace('.body.html','')
    out = pathlib.Path(f'{name}.dc.html')
    out.write_text(TPL.format(helmet=HELMET.rstrip(), body=pathlib.Path(p).read_text().rstrip()))
    print('wrote', out, out.stat().st_size)

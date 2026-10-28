import json,shutil,os,sys,html
H=os.path.expanduser('~/.cache/nomads-scratch/e2e')
PREFIX=sys.argv[1]; RD=os.path.expanduser('~/.cache/nomads-play/reports')
ROUND=sys.argv[2] if len(sys.argv)>2 else 'round 1'
issues=json.load(open(f'{H}/issues.json'))
def img(path):
    p=path if os.path.isabs(path) else f'{H}/{path}'
    name=f"e2e-{PREFIX}-{os.path.basename(path)}"
    shutil.copy(p, f"{RD}/{name}"); return name
sev_color={'crash or freeze':'#b00020','visibly broken':'#d84315','noticeable':'#f9a825','polish':'#5c8a2e'}
md=[f"# Globe e2e tester issues ({ROUND})\n",issues['header'],""]
cards=[]
for n,i in enumerate(issues['items'],1):
    imgs=[img(p) for p in i['images'] if os.path.exists(p if os.path.isabs(p) else f'{H}/{p}')]
    md.append(f"## {n}. {i['title']}\n- Severity: {i['sev']}\n- Seen: {i['seen']}\n- Status: {i['status']}\n- Matches fixlist: {i['match']}\n- Repro: {i['repro']}\n- Expected: {i.get('expected','')}\n- Evidence: "+", ".join(i['images'])+(f"\n- Cause guess: {i['cause']}" if i.get('cause') else '')+"\n")
    cards.append(f"<div class=card><h2><span class=n>{n}</span> {html.escape(i['title'])}</h2><p><b style='color:{sev_color[i['sev']]}'>{i['sev']}</b> &middot; {html.escape(i['match'])} &middot; {html.escape(i['status'])}</p><p>{html.escape(i['plain'])}</p><p class=small>Seen: {html.escape(i['seen'])}</p>"+"".join(f"<img src='{x}'>" for x in imgs)+f"<p class=small>Repro: {html.escape(i['repro'])}</p></div>")
open(f'{H}/issues.md','w').write("\n".join(md))
page=f"<!doctype html><meta charset=utf-8><title>Globe e2e: {ROUND}</title><style>body{{font:15px/1.45 -apple-system,sans-serif;max-width:1100px;margin:20px auto;padding:0 14px;background:#f4f1ea;color:#222}}.card{{background:#fff;border-radius:8px;padding:14px 18px;margin:16px 0;box-shadow:0 1px 4px #0002}}h2{{margin:0 0 6px;font-size:18px}}.n{{display:inline-block;background:#222;color:#fff;border-radius:50%;width:26px;height:26px;text-align:center;line-height:26px;margin-right:6px}}img{{max-width:100%;display:block;margin:8px 0;border:1px solid #ddd}}.small{{font-size:12px;color:#666}}</style><h1>Globe tester: {ROUND}</h1><p>{html.escape(issues['header'])}</p>"+"".join(cards)
open(f"{RD}/e2e-{PREFIX}.html",'w').write(page)
print(f"{RD}/e2e-{PREFIX}.html")

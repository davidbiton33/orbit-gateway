"""Dependency-free Python 3.11+ example. Runs on a backend, never browser JS."""
import json, os, urllib.request
base=os.environ.get('AI_GATEWAY_URL','http://127.0.0.1:4984/v1')
token=os.environ['AI_GATEWAY_TOKEN']
payload={'model':'claude','messages':[{'role':'user','content':'Hello from my agent'}]}
req=urllib.request.Request(base+'/chat/completions',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
with urllib.request.urlopen(req, timeout=240) as res:
    reply=json.load(res)
print(reply['choices'][0]['message']['content'])

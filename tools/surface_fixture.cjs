// DOM-only scheduler tests instantiate the same Vue template structure without
// running Vue, timers or WebGL. Browser tests cover the real renderer/lifecycle.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),contract=JSON.parse(fs.readFileSync(path.join(root,'frontend/views/surfaces.json'),'utf8'));
module.exports=function(document){return function(kind){
  const spec=contract[kind],box=document.createElement(spec.tag);box.className=spec.className;
  for(const [key,value] of Object.entries(spec.attributes||{})){box.setAttribute(key,value);if(key==='id')box.id=value;if(key==='hidden')box.hidden=true;}
  const html=fs.readFileSync(path.join(root,'frontend/components',spec.component),'utf8').split('<template>')[1].split('</template>')[0];
  const stack=[box];
  for(const match of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)){
    if(match[4]){if(match[4].trim())stack.at(-1).textContent=(stack.at(-1).textContent||'')+match[4];continue;}
    if(match[1]){if(stack.length>1)stack.pop();continue;}
    const node=document.createElement(match[2]);
    for(const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)){
      const key=attr[1],value=attr[2]??'';
      if(key==='class')node.className=value;else if(['hidden','checked','disabled'].includes(key))node[key]=true;else {node.setAttribute(key,value);if(['id','value','type','title'].includes(key))node[key]=value;if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
    }
    stack.at(-1).appendChild(node);if(!match[3].endsWith('/')&&!['img','input','br','hr'].includes(match[2]))stack.push(node);
  }
  const result={box};for(const [name,selector] of Object.entries(spec.selectors)){result[name]=box.querySelector(selector);if(!result[name])throw Error('Missing fixture surface '+kind+'.'+name);}
  box.__disposeView=()=>box.replaceChildren();return result;
};};

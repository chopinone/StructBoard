// Existing behavioral fixtures execute selected functions in a controlled VM.
// Resolve service wrappers to the actual module body; never retain a second copy
// of production logic. End-to-end tests exercise the real injected ports/bundle.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),cache=new Map();
function expanded() {
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
  return source.replace(/^  (?:async )?function (\w+)\([^\n]*\) \{ \/\* @service ([\w-]+) \w+ \*\/[\s\S]*?^  }/gm,(wrapper,name,group)=>{
    if(!cache.has(group))cache.set(group,fs.readFileSync(path.join(root,'frontend/runtime',group+'.mjs'),'utf8'));
    const body=cache.get(group).match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?^  }','m'));
    if(!body)throw Error('Missing service implementation '+group+'/'+name);
    return body[0].replace(/\bports\./g,'');
  });
}
module.exports={...fs,readFileSync(file,options){
  if(typeof file==='string'&&path.resolve(file)===path.join(root,'pipeline.html')) {
    const canvas=fs.readFileSync(path.join(root,'frontend/canvas/runtime.mjs'),'utf8').split('// CANVAS_RUNTIME_BEGIN')[1].split('// CANVAS_RUNTIME_END')[0];
    const value=fs.readFileSync(file,'utf8').replace('<script>/* @canvas-runtime */ window.SB_UI.startPipeline();</script>','<script>'+canvas+'</script>');
    return options?value:Buffer.from(value);
  }
  if(typeof file==='string'&&path.resolve(file)===path.join(root,'app.js')) {
    const value=expanded();return options?value:Buffer.from(value);
  }
  return fs.readFileSync(file,options);
}};

// Pure view projection. Tool execution stays in the chat engine, never in render.
export function transcriptTree(h,model,handlers) {
  function messageNode(message) {return h('div',{key:message.id,class:'ai-msg '+(message.role==='user'?'is-user':'is-ai'),'data-message-id':message.id},[
    ...message.parts.map((part,index)=>part.type==='text'
      ?h('div',{key:index,class:'ai-bubble-text'+(part.typing?' is-typing':'')},part.text)
      :h('details',{key:part.id||index,class:'ai-action-card',...(part.runnable?{open:true}:{})},[
        h('summary',{class:'ai-action-head'},[h('span',{class:'ai-action-tag'},part.runnable?'待确认':'查询详情'),h('code',{},part.name),
          h('span',{class:'ai-action-state'+(part.failed?' is-error':'')},part.status||'待确认')]),
        part.args&&h('pre',{class:'ai-action-args'},part.args),
        part.result&&h('pre',{class:'ai-action-args'},part.result),
        part.runnable&&h('div',{class:'ai-action-row'},[
          h('button',{type:'button',class:'ai-btn-primary',disabled:model.busy,onClick:()=>handlers.approve(part.id)},'执行'),
          h('button',{type:'button',class:'ai-btn-ghost',disabled:model.busy,onClick:()=>handlers.ignore(part.id)},'忽略'),
        ]),
      ].filter(Boolean))),
    message.error&&h('div',{class:'ai-err'},[message.error,h('button',{type:'button',class:'ai-btn-ghost',disabled:model.busy,onClick:()=>handlers.retry(message.turnId)},'重试本轮')]),
  ].filter(Boolean));}
  const rows=[];
  for(let i=0;i<model.messages.length;i++) {
    const message=model.messages[i];
    if(!message.process){rows.push(messageNode(message));continue;}
    const group=[message];
    while(i+1<model.messages.length&&model.messages[i+1].process&&model.messages[i+1].turnId===message.turnId)group.push(model.messages[++i]);
    const count=group.reduce((n,m)=>n+m.parts.filter(p=>p.type==='action').length,0);
    rows.push(h('details',{key:'process-'+message.id,class:'ai-process'},[
      h('summary',{class:'ai-process-summary'},'查看过程'+(count?' · '+count+' 项查询':'')),
      ...group.map(messageNode),
    ]));
  }
  return rows;
}

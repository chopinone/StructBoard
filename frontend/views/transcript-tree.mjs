// Pure view projection. Tool execution stays in the chat engine, never in render.
export function transcriptTree(h,model,handlers) {
  return model.messages.map(message=>h('div',{key:message.id,class:'ai-msg '+(message.role==='user'?'is-user':'is-ai'),'data-message-id':message.id},[
    ...message.parts.map((part,index)=>part.type==='text'
      ?h('div',{key:index,class:'ai-bubble-text'+(part.typing?' is-typing':'')},part.text)
      :h('div',{key:part.id||index,class:'ai-action-card'},[
        h('div',{class:'ai-action-head'},[h('span',{class:'ai-action-tag'},'动作'),h('code',{},part.name)]),
        part.args&&h('pre',{class:'ai-action-args'},part.args),
        part.status&&h('div',{class:part.ok?'ai-action-auto':'ai-action-err'},part.status),
        part.result&&h('pre',{class:'ai-action-args'},part.result),
        part.runnable&&h('div',{class:'ai-action-row'},[
          h('button',{type:'button',class:'ai-btn-primary',disabled:model.busy,onClick:()=>handlers.approve(part.id)},'执行'),
          h('button',{type:'button',class:'ai-btn-ghost',disabled:model.busy,onClick:()=>handlers.ignore(part.id)},'忽略'),
        ]),
      ].filter(Boolean))),
    message.error&&h('div',{class:'ai-err'},[message.error,h('button',{type:'button',class:'ai-btn-ghost',disabled:model.busy,onClick:()=>handlers.retry(message.turnId)},'重试本轮')]),
  ].filter(Boolean)));
}

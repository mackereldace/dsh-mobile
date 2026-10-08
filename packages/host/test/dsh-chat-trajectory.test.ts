import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore Browser asset is plain JavaScript.
import * as ui from '../assets/dsh-chat/ui.js'
const { traceTimeline } = ui
const events = [
  {seq:1,time:1000,type:'user/message',data:{text:'输入',turn:1}},
  {seq:2,time:2000,type:'assistant/message',data:{text:'模型',turn:1,step:1}},
  {seq:3,time:3000,type:'tool/call',data:{name:'bash',callId:'c1',arguments:'{}',turn:1,step:1}},
  {seq:4,time:4000,type:'tool/result',data:{callId:'c1',output:'结果'}},
]
test('真实泳道与默认顺序；内部同步不制造轨迹调用',()=>{
  const timeline = traceTimeline([...events,{seq:5,time:5000,type:'agent/inbox/spliced',data:{}}])
  assert.deepEqual(timeline.spans.map((s: {lane:number})=>s.lane),[0,1,2,2])
  assert.deepEqual(timeline.spans.map((s: {start:number,end:number})=>[s.start,s.end]),[[0,1],[1,2],[2,3],[3,4]])
  assert.equal(timeline.extent,4)
})
test('工具时长按真实callId结果配对，压缩空闲不双算重叠',()=>{
  const timeline=traceTimeline([...events,{seq:5,time:3200,type:'tool/call',data:{name:'read',callId:'c2',timeSeconds:.5}}],true)
  assert.equal(timeline.spans.find((s:{event:{seq:number}})=>s.event.seq===3).milliseconds,1000)
  assert.equal(timeline.spans.find((s:{event:{seq:number}})=>s.event.seq===5).milliseconds,500)
  assert.equal(timeline.extent,1003)
})
test('时长不编数字；坏时间在时长图中跳过，ISO startedAt可解析',()=>{
  const timeline=traceTimeline([{seq:1,type:'tool/call',data:{name:'bash'}},{seq:2,time:0,type:'tool/call',data:{name:'read',startedAt:'2026-10-08T00:00:00Z',timeSeconds:2}}],true)
  assert.equal(timeline.spans.length,1)
  assert.equal(timeline.extent,2000)
})

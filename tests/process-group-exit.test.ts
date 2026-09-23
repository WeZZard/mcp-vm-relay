import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmProcessGroupExit, groupAbsentFromProcessTable } from '../src/guest/receiver.js';

const absent = () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); };
test('termination observation allows asynchronous child exit without replaying the operation', async () => {
  let now=0, probes=0;
  const result=await confirmProcessGroupExit(123,{clock:()=>now,pause:async ms=>{now+=ms;},probe:()=>{if(++probes===3)absent();}});
  assert.equal(result,true);assert.equal(probes,3);assert.equal(now,50);
});
test('live group after deadline remains unconfirmed',async()=>{
  let now=0;
  assert.equal(await confirmProcessGroupExit(123,{timeoutMs:60,clock:()=>now,pause:async ms=>{now+=ms;},probe:()=>{}}),false);
  assert.equal(now,60);
});
test('EPERM needs independent successful observation, not permission bypass',async()=>{
  const denied=()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});};
  assert.equal(await confirmProcessGroupExit(123,{probe:denied,permissionObserver:async()=>true}),true);
  let now=0;
  assert.equal(await confirmProcessGroupExit(123,{timeoutMs:50,clock:()=>now,pause:async ms=>{now+=ms;},probe:denied,permissionObserver:async()=>false}),false);
  const self=`99 ${process.pid} S`;
  assert.equal(groupAbsentFromProcessTable(123,self+'\n123 456 Z'),false,'zombie members are not silently disregarded');
  assert.equal(groupAbsentFromProcessTable(123,self+'\n124 456 S'),true);
  assert.throws(()=>groupAbsentFromProcessTable(123,''));
  assert.throws(()=>groupAbsentFromProcessTable(123,'124 456 S'));
  assert.throws(()=>groupAbsentFromProcessTable(123,self+'\nmalformed'));
});
test('permission or observer errors never prove termination',async()=>{
  assert.equal(await confirmProcessGroupExit(123,{probe:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});},permissionObserver:async()=>undefined}),undefined);
  assert.equal(await confirmProcessGroupExit(123,{probe:absent}),true);
});

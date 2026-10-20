"use strict";
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const { createSaveConfirmation, isCandidate, classifySaveResponse } = require("./worker/saveConfirmation");

function fakeRequest({method="POST", url="https://api.istmspt.com/api/IncomingPackage/SaveSignature", body=""} = {}) {
  return {method:()=>method, url:()=>url, postData:()=>body};
}
function fakeResponse({request=fakeRequest(),status=200,body='{"success":true}',type="application/json"}={}) {
  return {request:()=>request,url:()=>request.url(), status:()=>status,
    headers:()=>({"content-type":type,"content-length":String(body.length)}), text:async()=>body};
}
class FakePage extends EventEmitter {
  constructor(){super();this.notifications=[];}
  locator(){return { evaluateAll: async()=>this.notifications }; }
}

async function verifySaveReceipts() {
  assert.equal(isCandidate(fakeRequest()),true);
  assert.equal(isCandidate(fakeRequest({method:"GET"})),false);
  assert.equal(isCandidate(fakeRequest({url:"https://api.istmspt.com/api/IncomingPackage/search"})),false);
  assert.equal(isCandidate(fakeRequest({url:"https://api.istmspt.com/api/IncomingPackage/Update",body:JSON.stringify({signatureName:"demo", trackingNumbers:[1]})})),true);
  assert.equal(isCandidate(fakeRequest({url:"https://evil.example/api/SaveSignature"})),false);
  assert.equal((await classifySaveResponse(fakeResponse({body:'{"success":false}'}))).ok,false);
  assert.equal((await classifySaveResponse(fakeResponse({status:500}))).ok,false);
  assert.equal((await classifySaveResponse(fakeResponse({body:'{"success":true}'}))).ok,true);

  const page = new FakePage();
  const m = createSaveConfirmation(page,{timeoutMs:1600});
  await m.start();
  page.emit("response",fakeResponse({request:fakeRequest({url:"https://api.istmspt.com/api/IncomingPackage/search"})}));
  setTimeout(()=>page.emit("response",fakeResponse()),70);
  const result=await m.wait();m.stop();
  assert.equal(result.confirmed,true);
  assert.match(result.signal,/save-response/);
  assert.equal(page.listenerCount("response"),0);

  const page2=new FakePage();
  const m2=createSaveConfirmation(page2,{timeoutMs:160});
  await m2.start();
  page2.emit("response",fakeResponse({request:fakeRequest({url:"https://api.istmspt.com/api/IncomingPackage/search"})}));
  assert.equal((await m2.wait()).confirmed,false);m2.stop();
  console.log("PASS: Save evidence accepts only relevant mutation or success signal.");
}

async function verifyBatchWorker() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"locker-fast-batch-"));
  const originalLoad=Module._load;
  const stats={completions:[],statuses:[],stages:[],successDeletes:0};
  let submitted={status:"completed",submitted:true,saveConfirmed:true,confirmedIds:["A","B"]};
  Module._load=function(request,parent,isMain){
    if (parent?.filename.endsWith(path.join("worker","batchJob.js"))) {
      if(request==="./batchSignature") return {processISTBatch:async(j, callbacks)=>{
        await callbacks.onStage("Selecting A in Get Signature");
        await callbacks.onStage("Selecting B in Get Signature");
        await callbacks.onBeforeSave();
        if (submitted===null) throw new Error("No receipt");
        return submitted;
      }};
      if(request==="./firebaseAdmin") return {
        completeWipItem:async(id,type,claim)=>{stats.completions.push([id,type,claim]);return {completed:true};},
        setAutomationStatus:async(id,claim,state,err)=>{stats.statuses.push([id,state,err]);return true;},
        setAutomationStage:async(id,claim,stage)=>{stats.stages.push([id,stage]);return true;},
      };
      if(request==="./queueHousekeeping") return {removeSuccessfulJob:async()=>stats.successDeletes++};
    }
    return originalLoad(request,parent,isMain);
  };
  const {processBatchJob}=require("./worker/batchJob");
  Module._load=originalLoad;
  const job={id:"job1",packageIds:["A","B"],signatureField:"Demo",filepath:path.join(tmp,"test.json"),status:"queued"};
  await processBatchJob(job);
  assert.deepEqual(stats.completions.map(x=>x[0]),["A","B"]);
  assert.equal(stats.successDeletes,1);
  assert.equal(stats.stages.length,2);
  assert.equal(stats.statuses.length,2); // processing claim ONLY
  assert.equal(job.status,"completed");

  submitted=null;
  const job2={...job,id:"job2",status:"queued",saveAttempted:false,filepath:path.join(tmp,"review.json")};
  await processBatchJob(job2);
  assert.equal(job2.status,"review");
  assert.equal(stats.completions.length,2); // no false completions
  assert.equal(stats.statuses.filter(v=>v[1]==="review").length,2);
  await fs.rm(tmp,{recursive:true,force:true});
  console.log("PASS: 2-ID success marks both Completed; unknown Save puts both in review; progress writes bounded.");
}
verifySaveReceipts().then(verifyBatchWorker).catch(e=>{console.error(e);process.exitCode=1;});

import assert from "node:assert/strict";
import test from "node:test";
import {S3ObjectStorage} from "../src/storage/s3-object-storage.mjs";

test("storage purge removes all exact object versions and delete markers, not neighboring keys",async()=>{
  const key="organizations/123/raw/data.csv";const commands=[];
  const storage=new S3ObjectStorage({bucket:"private",client:{async send(command){commands.push(command);
    if(command.constructor.name==="GetBucketVersioningCommand")return {Status:"Enabled"};
    if(command.constructor.name==="ListObjectVersionsCommand")return command.input.KeyMarker ? {Versions:[{Key:key,VersionId:"older"}],IsTruncated:false} :
      {Versions:[{Key:key,VersionId:"current"},{Key:key+".other",VersionId:"foreign"}],DeleteMarkers:[{Key:key,VersionId:"deleted"}],IsTruncated:true,NextKeyMarker:key,NextVersionIdMarker:"older"};
    return {};
  }}});
  await storage.purgeObject({key});
  assert.deepEqual(commands.filter(command=>command.constructor.name==="DeleteObjectCommand").map(command=>command.input),
    ["current","deleted","older"].map(VersionId=>({Bucket:"private",Key:key,VersionId})));
  await assert.rejects(storage.purgeObject({key:"../unsafe"}));
});
test("storage purge handles unversioned buckets and fails closed on broken pagination",async()=>{
  const commands=[];const storage=new S3ObjectStorage({bucket:"private",client:{async send(command){commands.push(command);return {};}}});
  await storage.purgeObject({key:"organizations/123/raw/data.csv"});
  assert.equal(commands.at(-1).constructor.name,"DeleteObjectCommand");
  const broken=new S3ObjectStorage({bucket:"private",client:{async send(command){return command.constructor.name==="GetBucketVersioningCommand" ? {Status:"Enabled"} : {IsTruncated:true};}}});
  await assert.rejects(broken.purgeObject({key:"organizations/123/raw/data.csv"}),{code:"OBJECT_STORAGE_ERROR"});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresIdentityRepository} from '../src/database/identity-repository.mjs';
import {PostgresDataIngestionRepository} from '../src/database/data-ingestion-repository.mjs';
import {PostgresVerifiedMetricsRepository} from '../src/database/verified-metrics-repository.mjs';
import {ProductionIngestionService} from '../src/ingestion/production-ingestion-service.mjs';
import {deriveCsvMetrics} from '../src/worker/production-worker.mjs';

test('verified report dates and more than 16 category/daily aggregates survive PostgreSQL exactly', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  try {
    const identity=new PostgresIdentityRepository(pool,{production:false}),nonce=randomUUID();
    const actor=await identity.createUser({email:`cube-${nonce}@example.com`,displayName:'Synthetic Cube Owner',password:'SyntheticCubeTest2026!'});
    const org=await identity.createOrganization({actorUserId:actor.id,name:'Synthetic cube test',slug:`cube-${nonce}`});
    const tenant={organizationId:org.id,actorUserId:actor.id};
    const csv='date,product,amount\n'+Array.from({length:31},(_,i)=>`2026-01-${String(i+1).padStart(2,'0')},Item ${i+1},${i+1}.25`).join('\n')+'\n';
    const ingestion=new ProductionIngestionService({repository:new PostgresDataIngestionRepository(pool),objectStorage:{async headObject(){return{exists:false};},async putObject(){}}});
    const upload=await ingestion.upload({...tenant,fileName:'synthetic.csv',content:csv,period:'2026-01',dataSeries:'Synthetic series'});
    const metrics=deriveCsvMetrics({body:Buffer.from(csv),originalFilename:'synthetic.csv'}),repo=new PostgresVerifiedMetricsRepository(pool);
    const amount=metrics.find(m=>m.sourceColumn==='amount');
    assert.equal(amount.evidence.reportAnalytics.metric.dates.length,1);
    assert.equal(amount.evidence.reportAnalytics.metric.all.dimensions[0].entries.length,31);
    await repo.replaceIngestionMetrics({organizationId:org.id,ingestionRunId:upload.ingestionRun.id,metrics});
    const series=await repo.listSeries(tenant),saved=series.find(m=>m.sourceColumn==='amount').points[0].evidence.reportAnalytics;
    assert.deepEqual(saved,amount.evidence.reportAnalytics);
    const excessive=structuredClone(amount);excessive.evidence.reportAnalytics.padding='x'.repeat(32769);
    await assert.rejects(repo.replaceIngestionMetrics({organizationId:org.id,ingestionRunId:upload.ingestionRun.id,metrics:[excessive]}),/budget/i);
    const after=await repo.listSeries(tenant);assert.deepEqual(after.find(m=>m.sourceColumn==='amount').points[0].evidence.reportAnalytics,saved);
  }finally{await pool.end();}
});

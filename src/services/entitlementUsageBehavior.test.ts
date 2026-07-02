import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = (relativePath: string) =>
  readFileSync(path.join(__dirname, relativePath), 'utf8');

test('publishing records PUBLISHED and publishedAt only after the LinkedIn API call', () => {
  const body = source('linkedinService.ts');
  const apiCall = body.indexOf('await axios.post(');
  const publishedUpdate = body.indexOf("status: 'PUBLISHED'", apiCall);

  assert.ok(apiCall >= 0);
  assert.ok(publishedUpdate > apiCall);
  assert.ok(body.indexOf('publishedAt,', publishedUpdate) > publishedUpdate);
});

test('scheduling does not create a published usage record', () => {
  const body = source('manualPostService.ts');
  const scheduleStart = body.indexOf('export async function scheduleManualPost');
  const nextFunction = body.indexOf('\nexport async function', scheduleStart + 1);
  const scheduleBody = body.slice(scheduleStart, nextFunction);

  assert.ok(scheduleStart >= 0);
  assert.equal(scheduleBody.includes("status: 'PUBLISHED'"), false);
  assert.equal(scheduleBody.includes('publishedAt:'), false);
});

test('image and manual AI usage are recorded after successful external generation', () => {
  const manualRoutes = source('../routes/manualPosts.ts');
  const imageGeneration = manualRoutes.indexOf('generateAndUploadManualAiImage({');
  const imageUsage = manualRoutes.indexOf('recordImageGeneration(userId)', imageGeneration);
  assert.ok(imageGeneration >= 0 && imageUsage > imageGeneration);

  const orchestration = source('manualPost/manualPostOrchestration.ts');
  const manualGeneration = orchestration.indexOf('runManualGenerationMultiStage(');
  const manualUsage = orchestration.indexOf("recordManualAiOperation(userId, 'generate')");
  assert.ok(manualGeneration >= 0 && manualUsage > manualGeneration);
});

test('batch quota counts job creation even when asynchronous generation later fails', () => {
  const body = source('../routes/botAction.ts');
  const jobCreated = body.indexOf('prisma.botGenerationJob.create({');
  const generationStarted = body.indexOf('botService', jobCreated);
  const failedStatus = body.indexOf('status: "FAILED"', generationStarted);

  assert.ok(jobCreated >= 0 && generationStarted > jobCreated);
  assert.ok(failedStatus > generationStarted);
});

test('saved-post rewrite enforcement remains per-post', () => {
  const body = source('planEntitlementService.ts');
  assert.ok(body.includes('post.rewriteCount >= ent.maxRewritesPerPost'));
});

import test from 'node:test';import assert from 'node:assert/strict';import {validateRequest,identifyModel} from '../src/lib/catalog.mjs';
test('generic model resolves provider',()=>{assert.equal(identifyModel('gpt').provider,'gpt');assert.equal(identifyModel('claude-sonnet').default,false);});
test('unrecognized thinking rejected',()=>assert.throws(()=>validateRequest({model:'claude',thinking:'extra_high'}),{code:'invalid_effort'}));
test('native projects rejected before dispatch',()=>assert.throws(()=>validateRequest({model:'gemini',project_mode:'native'}),{code:'native_project_unverified'}));

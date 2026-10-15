import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOrigins,originAllowed,corsOrigin,DEFAULT_ORIGIN} from '../supabase/functions/_shared/origins.js';

const GH='https://maxy747.github.io', COM='https://newform.example.com';

test('origins come from SITE_ORIGINS, then SITE_ORIGIN, then the GitHub Pages default',()=>{
 assert.deepEqual(parseOrigins(`${GH}, ${COM}/ ,`,undefined),[GH,COM]);
 assert.deepEqual(parseOrigins('',COM),[COM]);
 assert.deepEqual(parseOrigins(undefined,undefined),[DEFAULT_ORIGIN]);
});

test('only listed browser origins may call the API',()=>{
 const origins=[GH,COM];
 assert.equal(originAllowed(GH,origins),true);
 assert.equal(originAllowed(COM,origins),true);
 assert.equal(originAllowed('https://evil.example',origins),false);
 assert.equal(originAllowed(null,origins),true);
});

test('CORS echoes an allowed caller and falls back to the primary origin',()=>{
 const origins=[GH,COM];
 assert.equal(corsOrigin(COM,origins),COM);
 assert.equal(corsOrigin('https://evil.example',origins),GH);
 assert.equal(corsOrigin(null,origins),GH);
});

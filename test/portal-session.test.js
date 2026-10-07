'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalSession } = require('../lib/portal-session');
const origin = 'https://50five-snl.evc-net.com';
const loginPage = '<form><input name="emailField"><input name="passwordField"><input name="Login" value="Aanmelden"></form>';
const otpPage = '<form method="post" enctype="multipart/form-data"><input name="_token" value="csrf-test"><input name="_auth_code"></form>';
const cookie = 'PHPSESSID=test-session; Path=/; Secure; HttpOnly; Max-Age=86400';
const response = (status, data = '', headers = {}) => ({status, data, headers});
function fixture(steps, options = {}) {
    const requests = [];
    const client = new PortalSession({ ...options, transport: async config => {
        requests.push(config);
        assert.ok(steps.length, 'unexpected request: ' + config.url);
        const step = steps.shift();
        if (typeof step === 'function') return step(config);
        return step;
    }});
    return { client, requests, steps };
}
const challengeSteps = () => [response(200, loginPage, {'set-cookie':[cookie]}), response(302, '', {location:'/Overview'}), response(302, '', {location:'/2fa'}), response(200, otpPage)];
const validSteps = () => [response(200, '<h1>Dashboard</h1>'), response(200, '[[]]')];

test('pre-auth cookie does not count as login; multipart OTP preserves session and CSRF', async () => {
    const f = fixture([...challengeSteps(), config => {
        assert.match(config.headers.Cookie, /PHPSESSID=test-session/);
        const body = config.data.getBuffer().toString();
        assert.match(body, /name="_token"\r\n\r\ncsrf-test/);
        assert.match(body, /name="_auth_code"\r\n\r\n012345/);
        return response(302, '', {location:'/Overview', 'set-cookie':[cookie.replace('test-session','verified-session')]});
    }, ...validSteps()]);
    assert.deepEqual(await f.client.login(origin,'example-user','example-password'), {status:'otp_required'});
    assert.equal(f.client.state,'otp');
    const loginBody = f.requests[1].data.getBuffer().toString();
    assert.match(loginBody,/Aanmelden/);
    assert.deepEqual(await f.client.verify('012345'), {status:'authenticated'});
    assert.equal(f.client.token,null);
    assert.match(f.client.jar.getCookieStringSync(origin),/verified-session/);
    assert.equal(f.steps.length,0);
});

test('direct OTP redirect is supported', async () => {
    const f=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:'/2fa'}),response(200,otpPage)]);
    assert.equal((await f.client.login(origin,'u','p')).status,'otp_required');
});

test('wrong format never submits; wrong code refreshes CSRF and permits retry', async () => {
    const f=fixture([...challengeSteps(),response(302,'',{location:'/2fa'}),response(200,otpPage.replace('csrf-test','new-csrf')),response(302,'',{location:'/Overview'}),...validSteps()]);
    await f.client.login(origin,'u','p');
    const count=f.requests.length;
    await assert.rejects(f.client.verify('abc'),{code:'INVALID_OTP'});
    assert.equal(f.requests.length,count);
    await assert.rejects(f.client.verify('123456'),{code:'INVALID_OTP'});
    assert.equal(f.client.token,'new-csrf');
    assert.equal((await f.client.verify('654321')).status,'authenticated');
});

test('no-2FA account validated through dashboard and API, including empty account', async () => {
    const f=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:origin.replace('https:','http:')+'/Overview'}),...validSteps()]);
    assert.equal((await f.client.login(origin,'u','p')).status,'authenticated');
    assert.ok(f.requests.every(r=>r.url.startsWith('https:')));
});

test('incorrect password with a cookie is rejected', async () => {
    const f=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(200,loginPage)]);
    await assert.rejects(f.client.login(origin,'u','bad'),{code:'INVALID_LOGIN'});
    assert.notEqual(f.client.state,'authenticated');
});

test('a dashboard alone cannot confirm authentication', async () => {
    const f=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:'/Overview'}),response(200,'Dashboard'),response(200,loginPage)]);
    await assert.rejects(f.client.login(origin,'u','p'),{code:'AUTH_REQUIRED'});
});

test('cookie persistence survives restart, preserves expiry, and accepts rotation', async () => {
    const first=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:'/Overview'}),...validSteps()]);
    await first.client.login(origin,'u','p');
    const data=first.client.export();
    let saved;
    const next=fixture([...validSteps(),response(200,'[[{"ok":true}]]',{'set-cookie':[cookie.replace('test-session','rotated')]})],{load:async()=>data,save:async value=>{saved=value;}});
    await next.client.ensure(origin);
    assert.equal(next.client.export().cookies.cookies[0].creation,data.cookies.cookies[0].creation);
    await next.client.request('GET','/api/ajax?requests=test');
    assert.equal(saved.cookies.cookies[0].value,'rotated');
    assert.ok(next.requests.every(r=>!r.url.includes('/Login')));
});

test('expiry notifies once, stops requests, and never replays a charging command', async () => {
    let notices=0;
    const f=fixture([response(302,'',{location:'/2fa'})],{onExpired:async()=>{notices++;}});
    f.client.origin=origin;f.client.jar.setCookieSync(cookie,origin);f.client.state='authenticated';
    await assert.rejects(f.client.request('POST','/api/ajax','command'),{code:'AUTH_REQUIRED'});
    await assert.rejects(f.client.request('POST','/api/ajax','command'),{code:'AUTH_REQUIRED'});
    assert.equal(f.requests.length,1);assert.equal(notices,1);
});

test('expired persisted cookie and changed origin are not reused', async () => {
    const old=new PortalSession();old.origin=origin;old.jar.setCookieSync(cookie.replace('86400','0'),origin);
    const f=fixture([],{load:async()=>old.export()});
    await assert.rejects(f.client.ensure(origin),{code:'AUTH_REQUIRED'});
    await f.client.restore({origin,cookies:new PortalSession().jar.serializeSync()},'https://other.evc-net.com');
    assert.equal(f.client.hasCookie(),false);
    assert.equal(f.requests.length,0);
});

test('rejects credential-bearing URLs and external redirects', async () => {
    assert.throws(()=>PortalSession.origin('http://example.com'),{code:'INVALID_URL'});
    assert.throws(()=>PortalSession.origin('https://user:pass@example.com'),{code:'INVALID_URL'});
    const f=fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:'https://evil.example/Overview'})]);
    await assert.rejects(f.client.login(origin,'u','p'),{code:'UNEXPECTED_REDIRECT'});
    assert.equal(f.requests.length,2);
});

test('temporary server failure keeps authenticated session', async () => {
    const f=fixture([response(503)]);f.client.origin=origin;f.client.jar.setCookieSync(cookie,origin);f.client.state='authenticated';
    await assert.rejects(f.client.request('GET','/api/ajax'),/temporarily unavailable/);
    assert.equal(f.client.state,'authenticated');
});

test('transport errors never expose request secrets', async () => {
    const c=new PortalSession({transport:async()=>{throw new Error('Cookie: SECRET');}});c.origin=origin;
    await assert.rejects(c.raw('GET','/Overview'),e=>!e.message.includes('SECRET') && !e.config);
});

test('empty JSON from expired session is not treated as a successful command', async () => {
    const f=fixture([response(200,'[]'),response(302,'',{location:'/Login/Login'})]);
    f.client.origin=origin;f.client.jar.setCookieSync(cookie,origin);f.client.state='authenticated';
    await assert.rejects(f.client.request('GET','/api/ajax?command=start'),{code:'AUTH_REQUIRED'});
    assert.equal(f.requests.length,2);
});

test('concurrent startup requests share one restored-session validation', async () => {
    const c=new PortalSession();c.origin=origin;c.jar.setCookieSync(cookie,origin);
    const f=fixture(validSteps(),{load:async()=>c.export()});
    await Promise.all([f.client.ensure(origin),f.client.ensure(origin),f.client.ensure(origin)]);
    assert.equal(f.requests.length,2);
});

test('post-OTP validation uses the existing chargepoint GET request contract', async () => {
    let saved = false;
    const f = fixture([...challengeSteps(), response(302, '', {location:'/Overview'}),
        response(200, 'Dashboard'), config => {
            const url = new URL(config.url);
            if (config.method !== 'GET' || !url.searchParams.has('requests')) return response(200, '[]');
            assert.equal(url.searchParams.get('metricKey'), 'EndUserRechargeSpotListView_99');
            assert.deepEqual(JSON.parse(url.searchParams.get('requests')), {'0': {
                handler: '\\LMS\\EV\\AsyncServices\\DashboardAsyncService', method: 'networkOverview', params: {mode:'id'}
            }});
            assert.equal(config.data, undefined);
            return response(200, '[[{"IDX":42}]]');
        }], {save:async()=>{saved=true;}});
    await f.client.login(origin, 'u', 'p');
    assert.deepEqual(await f.client.verify('012345'), {status:'authenticated'});
    assert.equal(saved, true);
});

test('post-OTP response failure identifies the stage without exposing response secrets', async () => {
    for (const [body, stage] of [['<html>SECRET</html>', 'API_NOT_JSON'], ['[]', 'API_RESPONSE']]) {
        let saved = false;
        const f = fixture([...challengeSteps(), response(302, '', {location:'/Overview'}),
            response(200, 'Dashboard'), response(200, body)], {save:async()=>{saved=true;}});
        await f.client.login(origin, 'u', 'p');
        await assert.rejects(f.client.verify('012345'), e =>
            e.message.includes(stage + '; HTTP 200') && !e.message.includes('SECRET') && !e.message.includes('012345'));
        assert.equal(saved, false);
        assert.notEqual(f.client.state, 'authenticated');
    }
});

test('OTP redirect to login identifies submission failure separately from API validation', async () => {
    const f = fixture([...challengeSteps(), response(302, '', {location:'/Login/Login'})]);
    await f.client.login(origin, 'u', 'p');
    await assert.rejects(f.client.verify('012345'), /OTP_SUBMIT_LOGIN; HTTP 302/);
    assert.notEqual(f.client.state, 'authenticated');
});

test('OTP form without enctype is sent as browser URL-encoded fields and actual submit value', async () => {
    const page = '<form method="post" action="/2fa_check"><input type="hidden" name="_token" value="csrf-test"><input type="hidden" name="extra" value="a&amp;b"><input name="_auth_code"><button type="submit" name="VerifyOtp" value="Confirm">Confirm</button></form>';
    const f = fixture([response(200,loginPage,{'set-cookie':[cookie]}),response(302,'',{location:'/2fa'}), response(200,page), config => {
        assert.equal(config.method,'POST');
        assert.equal(config.headers['Content-Type'],'application/x-www-form-urlencoded');
        assert.deepEqual(Object.fromEntries(new URLSearchParams(config.data)), {
            _token:'csrf-test', extra:'a&b', VerifyOtp:'Confirm', _auth_code:'012345'
        });
        assert.match(config.headers.Cookie,/PHPSESSID=test-session/);
        return response(302,'',{location:'/2fa'});
    }, response(302,'',{location:'/Overview'}), ...validSteps()]);
    await f.client.login(origin,'u','p');
    assert.deepEqual(await f.client.verify('012345'),{status:'authenticated'});
});

test('OTP form redirect to dashboard alone never authenticates and a loop is bounded', async () => {
    let saved = false;
    const f = fixture([...challengeSteps(),response(302,'',{location:'/2fa'}),
        response(302,'',{location:'/Overview'}),response(302,'',{location:'/2fa'})],{save:async()=>{saved=true;}});
    await f.client.login(origin,'u','p');
    await assert.rejects(f.client.verify('012345'),/OTP_REDIRECT_LOOP/);
    assert.equal(saved,false);
    assert.notEqual(f.client.state,'authenticated');
    assert.equal(f.steps.length,0);
});

test('OTP form redirect to login distinguishes session loss from a rejected code', async () => {
    const f = fixture([...challengeSteps(),response(302,'',{location:'/2fa'}),response(302,'',{location:'/Login/Login'})]);
    await f.client.login(origin,'u','p');
    await assert.rejects(f.client.verify('012345'),/OTP_FORM_LOGIN; HTTP 302/);
    assert.notEqual(f.client.state,'authenticated');
});

test('alternate OTP landing pages require API proof and are never visited', async () => {
    for (const location of ['/EndUserRechargeSpotList', '/Overview?language=nl', '/Overview/']) {
        const f = fixture([...challengeSteps(), response(302, '', {location}), ...validSteps()]);
        await f.client.login(origin, 'u', 'p');
        assert.equal((await f.client.verify('012345')).status, 'authenticated');
        assert.equal(new URL(f.requests[5].url).pathname, '/Overview');
        assert.equal(f.steps.length, 0);
    }
});

test('unknown dashboard landing page uses only fixed read API and cannot bypass authentication', async () => {
    for (const [body, succeeds] of [['[[]]', true], ['[]', false], [loginPage, false]]) {
        let saved = false;
        const f = fixture([...challengeSteps(), response(302, '', {location:'/EndUserRechargeSpotList'}),
            response(302, '', {location:'/some-action'}), config => {
                assert.equal(new URL(config.url).pathname, '/api/ajax');
                assert.equal(config.method, 'GET');
                return response(200, body);
            }], {save:async value=>{if (value) saved=true;}});
        await f.client.login(origin, 'u', 'p');
        if (succeeds) assert.equal((await f.client.verify('012345')).status, 'authenticated');
        else await assert.rejects(f.client.verify('012345'), {code:'AUTH_REQUIRED'});
        assert.equal(saved, succeeds);
        assert.equal(f.steps.length, 0);
    }
});

test('foreign OTP landing page is rejected before validation', async () => {
    const f = fixture([...challengeSteps(), response(302, '', {location:'https://other.example/landing'})]);
    await f.client.login(origin, 'u', 'p');
    await assert.rejects(f.client.verify('012345'), {code:'UNEXPECTED_REDIRECT'});
    assert.equal(f.requests.length, 5);
});

test('OTP challenge can redirect to alternate landing page and Overview query is followed', async () => {
    const f = fixture([...challengeSteps(), response(302, '', {location:'/2fa'}),
        response(302, '', {location:'/EndUserRechargeSpotList'}),
        response(302, '', {location:'/Overview/?language=nl'}), ...validSteps()]);
    await f.client.login(origin, 'u', 'p');
    assert.equal((await f.client.verify('012345')).status, 'authenticated');
    assert.equal(new URL(f.requests[7].url).search, '?language=nl');
    assert.equal(f.steps.length, 0);
});

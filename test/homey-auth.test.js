'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

test('pair/repair keep existing credentials until OTP succeeds and await encryption',async()=>{
    const settings=new Map([['user_email','old-user'],['portal_session','old-session']]);
    const handlers={};
    class Session {
        static origin(){return 'https://50five-snl.evc-net.com';}
        async login(){return {status:'otp_required'};}
        async verify(code){if(code!=='123456')throw new Error('Invalid code');return {status:'authenticated'};}
        export(){return {cookies:'verified'};}
    }
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../drivers/chargepoint/driver.js'),'utf8'),{module,console,require:name=>{
        if(name==='homey')return {Driver:class {}};
        if(name.endsWith('/portal-session'))return {PortalSession:Session};
        if(name.endsWith('/homeycrypt'))return {crypt:async text=>{await Promise.resolve();return 'encrypted:'+text;}};
        return {};
    }});
    const driver=new module.exports();
    driver.homey={settings:{get:key=>settings.get(key),set:(key,value)=>settings.set(key,value)},__:key=>key};
    driver.sessionOptions={};driver.chargepointService={session:'old-client'};
    driver.registerAuthentication({setHandler:(name,handler)=>{handlers[name]=handler;}});
    assert.equal((await handlers.testlogin({username:'new-user',password:'new-password',url:''})).status,'otp_required');
    assert.equal(settings.get('user_email'),'old-user');
    assert.equal(settings.get('portal_session'),'old-session');
    await assert.rejects(handlers.verifyotp({code:'000000'}));
    assert.equal(driver.chargepointService.session,'old-client');
    assert.equal((await handlers.verifyotp({code:'123456'})).status,'authenticated');
    assert.equal(settings.get('user_email'),'new-user');
    assert.equal(settings.get('user_password'),'encrypted:new-password');
    assert.match(settings.get('portal_session'),/^encrypted:/);
    assert.ok(driver.chargepointService.session instanceof Session);
});

test('pair and repair scripts compile and every UI translation exists in EN/NL',()=>{
    for(const mode of ['pair','repair']){
        const html=fs.readFileSync(path.join(__dirname,`../drivers/chargepoint/${mode}/login.html`),'utf8');
        new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
        for(const lang of ['en','nl']){
            const strings=JSON.parse(fs.readFileSync(path.join(__dirname,`../locales/${lang}.json`),'utf8'));
            for(const match of html.matchAll(/auth\.([a-z_]+)/g)) assert.ok(strings.auth[match[1]],`${lang}: ${match[1]}`);
        }
    }
});

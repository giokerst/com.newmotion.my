'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { enhance } = require('../drivers/chargepoint/chargepoint');
const quiet = {log(){}, info(){}, debug(){}, dir(){}, warn(){}, error(){}};
function deviceFixture(error) {
    const module = {exports:{}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../drivers/chargepoint/device'), 'utf8'), {
        module, console: quiet, require: name => name === 'homey' ? {Device:class {}} : name === './chargepoint' ? {enhance} : {}
    });
    const d = new module.exports();
    const values = new Map([['meter_consumedmonth', 123], ['meter_consumedlast', 12], ['occupied', true]]);
    const point = {idx:'test', channel:'1'};
    const store = new Map([['deviceVersion','v2'], ['50five',point], ['cache',enhance({STATUS:'40000'})]]);
    Object.assign(d, {
        homey:{__:s=>s}, getSettings:()=>({}), getData:()=>({}),
        getStoreValue:k=>store.get(k), setStoreValue:async(k,v)=>store.set(k,v),
        hasCapability:()=>true, getCapabilityValue:k=>values.get(k),
        setCapabilityValue:async(k,v)=>values.set(k,v),
        setAvailable:async()=>{}, safeLog:()=>{}, error:()=>{},
        getLogLinedetailsAndSetMeters:async()=>null,
        chargepointService:{
            getAuthCookie:async()=>'ok', requestUpdate:async()=>{},
            pointDetails:async()=>({STATUS:'40000', CARDID:null}),
            TransactionHistory:async()=>{throw error;}
        }
    });
    return {d,values};
}
test('history failure preserves totals while live ready status updates', async () => {
    const {d,values} = deviceFixture(new Error('HTTP 404'));
    await d.updateDevice();
    assert.equal(values.get('occupied'), false);
    assert.equal(values.get('charging'), false);
    assert.equal(values.get('evcharger_charging_state'), 'plugged_out');
    assert.equal(values.get('meter_consumedmonth'), 123);
    assert.equal(values.get('meter_consumedlast'), 12);
});
test('history authentication failure is not swallowed', async () => {
    const error = Object.assign(new Error('repair'), {code:'AUTH_REQUIRED'});
    const {d} = deviceFixture(error);
    await assert.rejects(d.updateDevice(), {code:'AUTH_REQUIRED'});
});

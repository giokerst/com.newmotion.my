'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enhance } = require('../drivers/chargepoint/chargepoint');

test('reported ready status with car absent is free and has no active session', () => {
    for (const STATUS of ['40000', 40000, '0', 0]) {
        const { e } = enhance({ STATUS, NOTIFICATION: 'Gereed', CARDID: null });
        assert.equal(e.free, 1);
        assert.equal(e.occupied, 0);
        assert.equal(e.charging, 0);
        assert.equal(e.activeSession, false);
    }
});
test('charging and paused sessions remain occupied', () => {
    for (const STATUS of ['10000', 10000, '50000', 50000]) {
        const { e } = enhance({ STATUS, CARDID: 'test-card' });
        assert.equal(e.free, 0);
        assert.equal(e.activeSession, true);
        assert.equal(e.charging, String(STATUS) === '10000' ? 1 : 0);
    }
});
test('preparing and finishing connectors remain occupied without an active session', () => {
    for (const NOTIFICATION of ['Preparing transaction', 'Transactie voorbereiden', 'Finishing transaction']) {
        const { e } = enhance({ STATUS: '0', NOTIFICATION });
        assert.equal(e.free, 0);
        assert.equal(e.occupied, 1);
        assert.equal(e.activeSession, false);
    }
});

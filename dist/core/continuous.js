"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runContinuous = runContinuous;
const cycle_1 = require("./cycle");
const config_1 = require("../config");
async function runContinuous(options = {}) {
    const config = await (0, config_1.getConfig)();
    const defaultInterval = Number((0, config_1.getValue)(config, ['bot', 'cycle_interval_minutes'], 30));
    const interval = options.intervalMinutes ?? defaultInterval;
    let running = true;
    const shutdown = () => {
        console.log('\nGraceful shutdown requested, finishing current cycle...');
        running = false;
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    while (running) {
        await (0, cycle_1.runCycle)(options);
        if (!running)
            break;
        console.log(`Waiting ${interval} minute(s) for next cycle...`);
        await new Promise((resolve) => setTimeout(resolve, interval * 60 * 1000));
    }
}

"use strict";

const { promisify } = require("util");
const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

class EventQueueMail extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  // eslint-disable-next-line no-unused-vars
  async processPeriodicEvent(processContext, key, queueEntry) {
    console.log("processPeriodicEvent", processContext);
    console.log("key", key);
    console.log("queueEntry", queueEntry);
    const timestampLastRun = await this.getLastSuccessfulRunTimestamp();
    await promisify(setTimeout)(2000);
    const { uuid } = cds.utils
    
    await INSERT.into('dimple.Timer').entries([{
      ID: uuid(),
      name: "test1",
      description: "test1"
    }]);
    await INSERT.into('dimple.Timer').entries([{
      ID: uuid(),
      name: "test2",
      description: "test2"
    }]);

    console.log("SELECT.from('dimple.Timer')", await SELECT.from('dimple.Timer'));
    console.log(cds.context)
    this.logger.info("doing db health check...", {
      id: queueEntry.ID,
      timestampLastRun,
      now: new Date().toISOString(),
    });
    return undefined;
  }
}

module.exports = EventQueueMail;

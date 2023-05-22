"use strict";

const cds = require("@sap/cds");
const VError = require("verror");

const { Logger } = require("./shared/logger");
const { executeInNewTransaction } = require("./shared/cdsHelper");
const {
  EventTypeCode,
  EventSubTypeCode,
  EventProcessingStatus,
} = require("./constants");
const distributedLock = require("./shared/distributedLock");
const EventQueueError = require("./EventQueueError");
const { arrayToFlatMap } = require("./shared/common");
const eventQueueConfig = require("./config");

const IMPLEMENT_ERROR_MESSAGE = "needs to be reimplemented";
const COMPONENT_NAME = "eventQueue/EventQueueProcessorBase";
const VERROR_CLUSTER_NAME = "EventQueueProcessorBaseError";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_PARALLEL_EVENT_PROCESSING = 1;
const LIMIT_PARALLEL_EVENT_PROCESSING = 10;
const SELECT_LIMIT_EVENTS_PER_TICK = 100;

class EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    this.__context = context;
    this.__baseContext = context;
    this.__tx = cds.tx(context);
    this.__logger = Logger(context, COMPONENT_NAME);
    this.__eventProcessingMap = {};
    this.__statusMap = {};
    this.__commitedStatusMap = {};
    this.__eventType = eventType;
    this.__eventSubType = eventSubType;
    this.__queueEntriesWithPayloadMap = {};
    this.__config = config ?? {};
    this.__parallelEventProcessing =
      this.__config.parallelEventProcessing ??
      DEFAULT_PARALLEL_EVENT_PROCESSING;
    if (this.__parallelEventProcessing > LIMIT_PARALLEL_EVENT_PROCESSING) {
      this.__parallelEventProcessing = LIMIT_PARALLEL_EVENT_PROCESSING;
    }
    // NOTE: keep the feature, this might be needed again
    this.__concurrentEventProcessing = true;
    this.__startTime = this.__config.startTime ?? new Date();
    this.__retryAttempts =
      this.__config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.__selectMaxChunkSize =
      this.__config.selectMaxChunkSize ?? SELECT_LIMIT_EVENTS_PER_TICK;
    this.__selectNextChunk = !!this.__config.checkForNextChunk;
    this.__keepalivePromises = {};
    this.__outdatedCheckEnabled = this.__config.eventOutdatedCheck ?? true;
    this.__commitOnEventLevel = this.__config.commitOnEventLevel ?? false;
    this.__eventsWithExceededTries = [];
    this.__emptyChunkSelected = false;
    this.__lockAcquired = false;
    this.__txUsageAllowed = true;
    this.__txMap = {};
    this.__eventQueueConfig = eventQueueConfig.getConfigInstance();
  }

  /**
   * Process one or multiple events depending on the clustering algorithm by default there it's one event
   * @param processContext the context valid for the event processing. This context is associated with a valid transaction
   *                       Access to the context is also possible with this.getContextForEventProcessing(key).
   *                       The associated tx can be accessed with this.getTxForEventProcessing(key).
   * @param {string} key cluster key generated during the clustering step. By default, this is ID of the event queue entry
   * @param {Array<Object>} queueEntries this are the queueEntries which are collected during the clustering step for the given
   *        clustering key
   * @param {Object} payload resulting from the functions checkEventAndGeneratePayload and the clustering function
   * @returns {Promise<Array <Array <String, Number>>>} Must return an array of the length of passed queueEntries
   *          This array needs to be nested based on the following structure: [ ["eventId1", EventProcessingStatus.Done],
   *          ["eventId2", EventProcessingStatus.Error] ]
   */
  // eslint-disable-next-line no-unused-vars
  async processEvent(processContext, key, queueEntries, payload) {
    throw new Error(IMPLEMENT_ERROR_MESSAGE);
  }

  startPerformanceTracerEvents() {
    this.__performanceLoggerEvents =
      this.logger.startPerformanceTrace("Processing events");
  }

  startPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing = this.logger.startPerformanceTrace(
      "Preprocessing events"
    );
  }

  endPerformanceTracerEvents() {
    this.__performanceLoggerEvents?.endPerformanceTrace(
      { threshold: 50 },
      {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
      }
    );
  }

  endPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing?.endPerformanceTrace(
      { threshold: 50 },
      {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
      }
    );
  }

  logTimeExceeded(iterationCounter) {
    this.logger.info("Exiting event queue processing as max time exceeded", {
      additionalMessageProperties: {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
        iterationCounter,
      },
    });
  }

  static async insertIntoQueue(tx, entries) {
    for (const { type, subType } of Array.isArray(entries)
      ? entries
      : [entries]) {
      if (
        !Object.values(EventTypeCode).includes(type) ||
        !Object.values(EventSubTypeCode).includes(subType)
      ) {
        throw new VError(
          {
            name: VERROR_CLUSTER_NAME,
            info: { type, subType },
          },
          "Either the type or subType exists. Event rejected."
        );
      }
    }
    return await tx.run(
      INSERT.into(this.__eventQueueConfig.tableNameEventQueue).entries(entries)
    );
  }

  logStartMessage(queueEntries) {
    this.logger.info("Processing queue event", {
      level: "info",
      additionalMessageProperties: {
        numberQueueEntries: queueEntries.length,
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
      customFields: { quantity: queueEntries.length },
    });
  }

  /**
   * This function will be called for every event which should to be processed. Within this function basic validations
   * should be done, e.g. is the event still valid and should be processed. Also, this step should be used to gather the
   * required data for the clustering step. Keep in mind that this function will be called for every event and not once
   * for all events. Mass data select should be done later (beforeProcessingEvents).
   * If no payload is returned the status will be set to done. Transaction is available with this.tx;
   * this transaction will always be rollbacked so do not use this transaction persisting data.
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   * @returns {Promise<Object>} payload which is needed for clustering the events.
   */
  async checkEventAndGeneratePayload(queueEntry) {
    return queueEntry.payload;
  }

  /**
   * This function will be called for every event which should to be processed. This functions sets for every event
   * the payload which will be passed to the clustering functions.
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   * @param {Object} payload which is the result of checkEventAndGeneratePayload
   */
  addEventWithPayloadForProcessing(queueEntry, payload) {
    if (!this.__queueEntriesMap[queueEntry.ID]) {
      this.logger.error(
        "The supplied queueEntry has not been selected before and should not be processed. Entry will not be processed.",
        {
          additionalMessageProperties: {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
            queueEntryId: queueEntry.ID,
          },
        }
      );
      return;
    }
    this.__queueEntriesWithPayloadMap[queueEntry.ID] = {
      queueEntry,
      payload,
    };
  }

  /**
   * This function sets the status of an queueEntry to done
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   */
  setStatusToDone(queueEntry) {
    this.logger.debug("setting status for queueEntry to done", {
      additionalMessageProperties: {
        id: queueEntry.ID,
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
    });
    this._determineAndAddEventStatusToMap(
      queueEntry.ID,
      EventProcessingStatus.Done
    );
  }

  /**
   * This function allows to cluster multiple events so that they will be processed together. By default, there is no
   * clustering happening. Therefore, the cluster key is the ID of the event. If an alternative clustering is needed
   * this function should be overwritten. For every cluster-key the function processEvent will be called once.
   * This can be useful for e.g. multiple tasks have been scheduled and always the same user should be informed.
   * In this case the events should be clustered together and only one mail should be sent.
   */
  clusterQueueEntries() {
    Object.entries(this.__queueEntriesWithPayloadMap).forEach(
      ([key, { queueEntry, payload }]) => {
        this._addEntryToProcessingMap(key, queueEntry, payload);
      }
    );
  }

  _addEntryToProcessingMap(key, queueEntry, payload) {
    this.logger.debug("add entry to processing map", {
      additionalMessageProperties: {
        key,
        queueEntry,
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
    });
    this.__eventProcessingMap[key] = this.__eventProcessingMap[key] ?? {
      queueEntries: [],
      payload,
    };
    this.__eventProcessingMap[key].queueEntries.push(queueEntry);
  }

  /**
   * This function sets the status of multiple events to a given status. If the structure of queueEntryProcessingStatusTuple
   * is not as expected all events will be set to error. The function respects the config commitOnEventLevel. If
   * commitOnEventLevel is true the status will be written to a dedicated map and returned afterwards to handle concurrent
   * event processing.
   * @param {Array} queueEntries which has been selected from event queue table and been modified by modifyQueueEntry
   * @param {Array<Object>} queueEntryProcessingStatusTuple Array of tuple <queueEntryId, processingStatus>
   * @return {Object} statusMap Map which contains all events for which a status has been set so far
   */
  setEventStatus(queueEntries, queueEntryProcessingStatusTuple) {
    this.logger.debug("setting event status for entries", {
      additionalMessageProperties: {
        queueEntryProcessingStatusTuple: JSON.stringify(
          queueEntryProcessingStatusTuple
        ),
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
    });
    const statusMap = this.__commitOnEventLevel ? {} : this.__statusMap;
    try {
      queueEntryProcessingStatusTuple.forEach(([id, processingStatus]) =>
        this._determineAndAddEventStatusToMap(id, processingStatus, statusMap)
      );
    } catch (error) {
      queueEntries.forEach((queueEntry) =>
        this._determineAndAddEventStatusToMap(
          queueEntry.ID,
          EventProcessingStatus.Error,
          statusMap
        )
      );
      this.logger.error(
        "The supplied status tuple doesn't have the required structure. Setting all entries to error",
        {
          error,
          additionalMessageProperties: {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
          },
        }
      );
    }
    return statusMap;
  }

  /**
   * This function allows to modify a select queueEntry (event) before processing. By default, the payload of the event
   * is parsed. The return value of the function is ignored, it's required to modify the reference which is passed into
   * the function.
   * @param {Object} queueEntry which has been selected from event queue table
   */
  modifyQueueEntry(queueEntry) {
    queueEntry.payload = JSON.parse(queueEntry.payload);
  }

  _determineAndAddEventStatusToMap(
    id,
    processingStatus,
    statusMap = this.__statusMap
  ) {
    if (!statusMap[id]) {
      statusMap[id] = processingStatus;
      return;
    }
    if (statusMap[id] === EventProcessingStatus.Error) {
      // NOTE: worst aggregation --> if already error keep this state
      return;
    }
    if (statusMap[id] >= 0) {
      statusMap[id] = processingStatus;
    }
  }

  handleErrorDuringProcessing(error, queueEntries) {
    queueEntries = Array.isArray(queueEntries) ? queueEntries : [queueEntries];
    this.logger.error(
      "Unexpected error during event processing - setting queue entry to error",
      {
        additionalMessageProperties: {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
          queueEntriesIds: queueEntries.map(({ ID }) => ID),
        },
        error,
      }
    );
    queueEntries.forEach((queueEntry) =>
      this._determineAndAddEventStatusToMap(
        queueEntry.ID,
        EventProcessingStatus.Error
      )
    );
    return Object.fromEntries(
      queueEntries.map((queueEntry) => [
        queueEntry.ID,
        EventProcessingStatus.Error,
      ])
    );
  }

  /**
   * This function validates for all selected events one status has been submitted. It's also validated that only for
   * selected events a status has been submitted. Persisting the status of events is done in a dedicated database tx.
   * The function accepts no arguments as there are dedicated functions to set the status of events (e.g. setEventStatus)
   */
  async persistEventStatus(
    tx,
    { skipChecks, statusMap = this.__statusMap } = {}
  ) {
    this.logger.debug("entering persistEventStatus", {
      additionalMessageProperties: {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
    });
    this._ensureOnlySelectedQueueEntries(statusMap);
    if (!skipChecks) {
      this._ensureEveryQueueEntryHasStatus();
    }
    this._ensureEveryStatusIsAllowed(statusMap);

    const { success, failed, invalidAttempts } = Object.entries(
      statusMap
    ).reduce(
      (result, [notificationEntityId, processingStatus]) => {
        this.__commitedStatusMap[notificationEntityId] = processingStatus;
        if (processingStatus === EventProcessingStatus.Open) {
          result.invalidAttempts.push(notificationEntityId);
        } else if (processingStatus === EventProcessingStatus.Done) {
          result.success.push(notificationEntityId);
        } else if (processingStatus === EventProcessingStatus.Error) {
          result.failed.push(notificationEntityId);
        }
        return result;
      },
      {
        success: [],
        failed: [],
        invalidAttempts: [],
      }
    );
    this.logger.debug("persistEventStatus for entries", {
      additionalMessageProperties: {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
        invalidAttempts,
        failed,
        success,
      },
    });
    if (invalidAttempts.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .set({
            status: EventProcessingStatus.Open,
            lastAttemptTimestamp: new Date().toISOString(),
            attempts: { "-=": 1 },
          })
          .where("ID IN", invalidAttempts)
      );
    }
    if (success.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .set({
            status: EventProcessingStatus.Done,
            lastAttemptTimestamp: new Date().toISOString(),
          })
          .where("ID IN", success)
      );
    }
    if (failed.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .where("ID IN", failed)
          .with({
            status: EventProcessingStatus.Error,
            lastAttemptTimestamp: new Date().toISOString(),
          })
      );
    }
    this.logger.debug("exiting persistEventStatus", {
      additionalMessageProperties: {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      },
    });
  }

  _ensureEveryQueueEntryHasStatus() {
    this.__queueEntries.forEach((queueEntry) => {
      if (
        queueEntry.ID in this.__statusMap ||
        queueEntry.ID in this.__commitedStatusMap
      ) {
        return;
      }
      this.logger.error(
        "Missing status for selected event entry. Setting status to error",
        {
          additionalMessageProperties: {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
            queueEntry,
          },
        }
      );
      this._determineAndAddEventStatusToMap(
        queueEntry.ID,
        EventProcessingStatus.Error
      );
    });
  }

  _ensureEveryStatusIsAllowed(statusMap) {
    Object.entries(statusMap).forEach(([queueEntryId, status]) => {
      if (
        [
          EventProcessingStatus.Open,
          EventProcessingStatus.Done,
          EventProcessingStatus.Error,
        ].includes(status)
      ) {
        return;
      }

      this.logger.error(
        "Not allowed event status returned. Only Open, Done, Error is allowed!",
        {
          additionalMessageProperties: {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
            queueEntryId,
          },
        }
      );
      delete statusMap[queueEntryId];
    });
  }

  _ensureOnlySelectedQueueEntries(statusMap) {
    Object.keys(statusMap).forEach((queueEntryId) => {
      if (this.__queueEntriesMap[queueEntryId]) {
        return;
      }

      this.logger.error(
        "Status reported for event queue entry which haven't be selected before. Removing the status.",
        {
          additionalMessageProperties: {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
            queueEntryId,
          },
        }
      );
      delete statusMap[queueEntryId];
    });
  }

  handleErrorDuringClustering(error) {
    this.logger.error(
      "Error during clustering of events - setting all queue entries to error",
      {
        additionalMessageProperties: {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
        },
        error,
      }
    );
    this.__queueEntries.forEach((queueEntry) => {
      this._determineAndAddEventStatusToMap(
        queueEntry.ID,
        EventProcessingStatus.Error
      );
    });
  }

  handleInvalidPayloadReturned(queueEntry) {
    this.logger.error(
      "Undefined payload is not allowed. If status should be done, nulls needs to be returned" +
        " - setting queue entry to error",
      {
        additionalMessageProperties: {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
        },
      }
    );
    this._determineAndAddEventStatusToMap(
      queueEntry.ID,
      EventProcessingStatus.Error
    );
  }

  static async handleMissingTypeImplementation(
    context,
    eventType,
    eventSubType
  ) {
    const baseInstance = new EventQueueProcessorBase(
      context,
      eventType,
      eventSubType
    );
    baseInstance.logger.error(
      "No Implementation found for queue type in 'eventTypeRegister.js'",
      {
        additionalMessageProperties: {
          eventType,
          eventSubType,
        },
      }
    );
  }

  /**
   * This function selects all relevant events based on the eventType and eventSubType supplied through the constructor
   * during initialization of the class.
   * Relevant Events for selection are: open events, error events if the number retry attempts has not been succeeded or
   * events which are in progress for longer than 30 minutes.
   * @return {Promise<Array<Object>>} all relevant events for processing for the given eventType and eventSubType
   */
  async getQueueEntriesAndSetToInProgress() {
    let result = [];
    await executeInNewTransaction(
      this.__baseContext,
      "eventQueue-getQueueEntriesAndSetToInProgress",
      async (tx) => {
        const entries = await tx.run(
          SELECT.from(this.__eventQueueConfig.tableNameEventQueue)
            .forUpdate({ wait: this.__eventQueueConfig.forUpdateTimeout })
            .limit(this.getSelectMaxChunkSize())
            .where(
              "type =",
              this.__eventType,
              "AND subType=",
              this.__eventSubType,
              "AND ( status =",
              EventProcessingStatus.Open,
              "OR ( status =",
              EventProcessingStatus.Error,
              "AND lastAttemptTimestamp <=",
              this.__startTime.toISOString(),
              ") OR ( status =",
              EventProcessingStatus.InProgress,
              "AND lastAttemptTimestamp <=",
              new Date(
                new Date().getTime() - this.__eventQueueConfig.globalTxTimeout
              ).toISOString(),
              ") )"
            )
            .orderBy("createdAt", "ID")
        );

        if (!entries.length) {
          this.logger.debug("no entries available for processing", {
            additionalMessageProperties: {
              eventType: this.__eventType,
              eventSubType: this.__eventSubType,
            },
          });
          this.__emptyChunkSelected = true;
          return;
        }

        const { exceededTries, openEvents } =
          this._filterExceededEvents(entries);
        if (exceededTries.length) {
          this.__eventsWithExceededTries = exceededTries;
        }
        result = openEvents;

        if (!result.length) {
          this.__emptyChunkSelected = true;
          return;
        }

        this.logger.info("Selected event queue entries for processing", {
          additionalMessageProperties: {
            queueEntriesCount: result.length,
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
          },
        });

        const isoTimestamp = new Date().toISOString();
        await tx.run(
          UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
            .with({
              status: EventProcessingStatus.InProgress,
              lastAttemptTimestamp: isoTimestamp,
              attempts: { "+=": 1 },
            })
            .where(
              "ID IN",
              result.map(({ ID }) => ID)
            )
        );
        result.forEach((entry) => (entry.lastAttemptTimestamp = isoTimestamp));
      }
    );
    this.__queueEntries = result;
    this.__queueEntriesMap = arrayToFlatMap(result);
    return result;
  }

  _filterExceededEvents(events) {
    return events.reduce(
      (result, event) => {
        if (event.attempts === this.__retryAttempts) {
          result.exceededTries.push(event);
        } else {
          result.openEvents.push(event);
        }
        return result;
      },
      { exceededTries: [], openEvents: [] }
    );
  }

  async handleExceededEvents(exceededEvents) {
    await this.tx.run(
      UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
        .with({
          status: EventProcessingStatus.Exceeded,
        })
        .where(
          "ID IN",
          exceededEvents.map(({ ID }) => ID)
        )
    );
    this.logger.error(
      "The retry attempts for the following events are exceeded",
      {
        additionalMessageProperties: {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
          retryAttempts: this.__retryAttempts,
          queueEntriesIds: exceededEvents.map(({ ID }) => ID),
        },
      }
    );
    await this.hookForExceededEvents(exceededEvents);
  }

  /**
   * This function enables the possibility to execute custom actions for events for which the retry attempts have been
   * exceeded. As always a valid transaction is available with this.tx. This transaction will be committed after the
   * execution of this function.
   * @param {Object} exceededEvents exceeded event queue entries
   */
  // eslint-disable-next-line no-unused-vars
  async hookForExceededEvents(exceededEvents) {}

  /**
   * This function serves the purpose of mass enabled preloading data for processing the events which are added with
   * the function 'addEventWithPayloadForProcessing'. This function is called after the clustering and before the
   * process-events-steps. The event data is available with this.eventProcessingMap.
   */
  // eslint-disable-next-line no-unused-vars
  async beforeProcessingEvents() {}

  /**
   * This function checks if the db records of events have been modified since the selection (beginning of processing)
   * If the db records are unmodified the field lastAttemptTimestamp of the records is updated to
   * "send a keep alive signal". This extends the allowed processing time of the events as events which are in progress
   * for more than 30 minutes (global tx timeout) are selected with the next tick.
   * If events are outdated/modified these events are not being processed and no status will be persisted.
   * @return {Promise<boolean>} true if the db record of the event has been modified since selection
   */
  async isOutdatedAndKeepalive(queueEntries) {
    if (!this.__outdatedCheckEnabled) {
      return false;
    }
    let eventOutdated;
    const runningChecks = queueEntries
      .map((queueEntry) => this.__keepalivePromises[queueEntry.ID])
      .filter((p) => p);
    if (runningChecks.length === queueEntries.length) {
      const results = await Promise.allSettled(runningChecks);
      for (const { value } of results) {
        if (value) {
          return true;
        }
      }
      return false;
    } else if (runningChecks.length) {
      await Promise.allSettled(runningChecks);
    }
    const checkAndUpdatePromise = new Promise((resolve) => {
      executeInNewTransaction(
        this.__baseContext,
        "eventProcessing-isOutdatedAndKeepalive",
        async (tx) => {
          const queueEntriesFresh = await tx.run(
            SELECT.from(this.__eventQueueConfig.tableNameEventQueue)
              .forUpdate({ wait: this.__eventQueueConfig.forUpdateTimeout })
              .where(
                "ID IN",
                queueEntries.map(({ ID }) => ID)
              )
              .columns("ID", "lastAttemptTimestamp")
          );
          eventOutdated = queueEntriesFresh.some((queueEntryFresh) => {
            const queueEntry = this.__queueEntriesMap[queueEntryFresh.ID];
            return (
              queueEntry?.lastAttemptTimestamp !==
              queueEntryFresh.lastAttemptTimestamp
            );
          });
          let newTs = new Date().toISOString();
          if (!eventOutdated) {
            await tx.run(
              UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
                .set("lastAttemptTimestamp =", newTs)
                .where(
                  "ID IN",
                  queueEntries.map(({ ID }) => ID)
                )
            );
          } else {
            newTs = null;
            this.logger.warn(
              "event data has been modified. Processing skipped.",
              {
                additionalMessageProperties: {
                  eventType: this.__eventType,
                  eventSubType: this.__eventSubType,
                  queueEntriesIds: queueEntries.map(({ ID }) => ID),
                },
              }
            );
            queueEntries.forEach(
              ({ ID: queueEntryId }) =>
                delete this.__queueEntriesMap[queueEntryId]
            );
          }
          this.__queueEntries = Object.values(this.__queueEntriesMap);
          queueEntriesFresh.forEach((queueEntryFresh) => {
            if (this.__queueEntriesMap[queueEntryFresh.ID]) {
              const queueEntry = this.__queueEntriesMap[queueEntryFresh.ID];
              if (newTs) {
                queueEntry.lastAttemptTimestamp = newTs;
              }
            }
            delete this.__keepalivePromises[queueEntryFresh.ID];
          });
          resolve(eventOutdated);
        }
      );
    });

    queueEntries.forEach(
      (queueEntry) =>
        (this.__keepalivePromises[queueEntry.ID] = checkAndUpdatePromise)
    );
    return await checkAndUpdatePromise;
  }

  async handleDistributedLock() {
    if (this.concurrentEventProcessing) {
      return true;
    }

    const lockAcquired = await distributedLock.acquireLock(
      this.context,
      [this.eventType, this.eventSubType].join("##")
    );
    if (!lockAcquired) {
      return false;
    }
    this.__lockAcquired = true;
    return true;
  }

  async handleReleaseLock() {
    if (!this.__lockAcquired) {
      return;
    }
    try {
      await distributedLock.releaseLock(
        this.context,
        [this.eventType, this.eventSubType].join("##")
      );
    } catch (err) {
      this.logger.error("Releasing distributed lock failed", { error: err });
    }
  }

  statusMapContainsError(statusMap) {
    return Object.values(statusMap).includes(EventProcessingStatus.Error);
  }

  getSelectNextChunk() {
    return this.__selectNextChunk;
  }

  getSelectMaxChunkSize() {
    return this.__selectMaxChunkSize;
  }

  clearEventProcessingContext() {
    this.__processContext = null;
    this.__processTx = null;
  }

  get shouldTriggerRollback() {
    return (
      this.statusMapContainsError(this.__statusMap) ||
      this.statusMapContainsError(this.__commitedStatusMap)
    );
  }

  get logger() {
    return this.__logger;
  }

  get queueEntriesWithPayloadMap() {
    return this.__queueEntriesWithPayloadMap;
  }

  get eventProcessingMap() {
    return this.__eventProcessingMap;
  }

  get parallelEventProcessing() {
    return this.__parallelEventProcessing;
  }

  get concurrentEventProcessing() {
    return this.__concurrentEventProcessing;
  }

  set processEventContext(context) {
    if (!context) {
      this.__processContext = null;
      this.__processTx = null;
      return;
    }
    this.__processContext = context;
    this.__processTx = cds.tx(context);
  }

  get tx() {
    if (!this.__txUsageAllowed && this.__parallelEventProcessing > 1) {
      throw EventQueueError.wrongTxUsage(this.eventType, this.eventSubType);
    }
    return this.__processTx ?? this.__tx;
  }

  get context() {
    if (!this.__txUsageAllowed && this.__parallelEventProcessing > 1) {
      throw EventQueueError.wrongTxUsage(this.eventType, this.eventSubType);
    }
    return this.__processContext ?? this.__context;
  }

  get baseContext() {
    return this.__baseContext;
  }

  get commitOnEventLevel() {
    return this.__commitOnEventLevel;
  }

  get eventType() {
    return this.__eventType;
  }

  get eventSubType() {
    return this.__eventSubType;
  }

  get exceededEvents() {
    return this.__eventsWithExceededTries;
  }

  get emptyChunkSelected() {
    return this.__emptyChunkSelected;
  }

  set txUsageAllowed(value) {
    this.__txUsageAllowed = value;
  }

  getContextForEventProcessing(key) {
    return this.__txMap[key]?.context;
  }

  getTxForEventProcessing(key) {
    return this.__txMap[key];
  }

  setTxForEventProcessing(key, tx) {
    this.__txMap[key] = tx;
  }
}

module.exports = EventQueueProcessorBase;

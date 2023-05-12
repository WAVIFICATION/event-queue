namespace sap.eventQueue;

using cuid from '@sap/cds/common';

@sap.value.list: 'fixed-values'
type Status: Integer enum {
    Open = 0;
    InProgress = 1;
    Done = 2;
    Error = 3;
    Exceeded = 4;
}

@cds.persistence.journal
@AFC.Description: 'Event Queue'
entity EventQueue: cuid {
    type: String not null;
    subType: String not null;
    referenceEntity: String;
    referenceEntityKey: UUID;
    status: Status default 0 not null;
    payload: LargeString;
    attempts: Integer default 0 not null;
    lastAttemptTimestamp: Timestamp;
}

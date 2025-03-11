namespace dimple;

using cuid from '@sap/cds/common';
using managed from '@sap/cds/common';

entity Task: cuid, managed {
    description: String;
    status: String default 'open';
}

entity Timer: cuid, managed {
    name: String;
    description: String;
    status: String default 'open';
}
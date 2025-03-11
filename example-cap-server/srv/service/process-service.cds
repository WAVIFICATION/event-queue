
using dimple as sample from '../../db/Task';

@impl: './../handler/process-service.js'
service ProcessService {
    entity C_ClosingTask as projection on sample.Task
    actions {
        action process();
    };
    entity C_Timer as projection on sample.Timer

}

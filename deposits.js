// Background tx processor for handling deposits and withdrawals
const async = require('async');
const config = require('./config/config');
const mysql = require('mysql');
const request = require('request');
if (config.debug) {
    require('request-debug')(request);
}

// Connect to the database
let db;
const initSqlConnection = () => {
    const _db = mysql.createConnection({
        host: config.mariadb.host,
        user: config.mariadb.username,
        password: config.mariadb.password,
        database: config.mariadb.database,
        charset: 'utf8mb4',
        timezone: 'Z'
    });
    
    _db.on('error', (err) => {
        if (err.code === 2006 || ['PROTOCOL_CONNECTION_LOST', 'PROTOCOL_PACKETS_OUT_OF_ORDER', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'].indexOf(err.code) > -1) {
            _db.destroy();
            db = initSqlConnection();
        }
    });
    
    return _db;
};
db = initSqlConnection();

const userIdForDepositAddress = (address, callback) => {
    db.query('SELECT Id FROM Users WHERE DepositAddress = ?', [address], (err, res) => {
        if (err) {
            return callback(err, null);
        }
        
        if (res.length === 0) {
            return callback(new Error(`User with deposit address ${address} not found.`));
        }
        
        return callback(null, res[0].Id);
    });
};

const createDeposit = (address, txhash, amount, confirmations, callback) => {
    async.waterfall([
        (cb) => {
            userIdForDepositAddress(address, cb);
        },
        (depositorId, cb) => {
            db.query('INSERT INTO Deposits (UserId, TxHash, Amount, Confirmations, Created) VALUES (?, ?, ?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE Confirmations = ?',
                     [depositorId, txhash, amount, confirmations, confirmations], cb);
        }           
    ], callback);
};

const confirmationsForTx = (txhash, callback) => {
    request.post({ url: config.lbrycrd.rpcurl, json: { method: 'gettransaction', params: [txhash] } }, (err, res, body) => {
        if (body.error) {
            return callback(body.error, null);
        }
        
        return callback(null, body.result.confirmations);
    });
};

const processNewDeposits = (callback) => {
    async.waterfall([
        (cb) => {
            request.post({ url: config.lbrycrd.rpcurl, json: { method: 'listtransactions', params: [config.lbrycrd.account, 1000] } }, cb);
        },
        (res, body, cb) => {
            if (body.error) {
                return cb(body.error, null);
            }

            // simply insert the deposits
            return async.each(body.result, (tx, ecb) => {
                if (tx.amount <= 0) {
                    return ecb(null, null);   
                }
                return createDeposit(tx.address, tx.txid, tx.amount, tx.confirmations, ecb);
            }, cb);
        }
    ], callback);
};

// deposits with confirmations < 3
const processPendingDeposits = (callback) => {
    async.waterfall([
        (cb) => {
            db.query('SELECT Id, TxHash FROM Deposits WHERE Confirmations < 3', cb);
        },
        (res, fields, cb) => {
            if (res.length === 0) {
                return cb(null, []);
            }
            
            return async.each(res, (deposit, ecb) => {
                confirmationsForTx(deposit.TxHash, (err, confirmations) => {
                    if (err) {
                        return ecb(err, null);
                    }
                    
                    db.query('UPDATE Deposits SET Confirmations = ? WHERE Id = ?', [confirmations, deposit.Id], ecb);
                });
            }, cb);
        }
    ], callback);  
};

const runProcess = () => {
    async.waterfall([
        (cb) => {
            console.log('Processing new deposits.');
            processNewDeposits(cb);
        },
        (cb) => {
            console.log('Processing pending deposits.');
            processPendingDeposits(cb);
        }
    ], (err) => {
        if (err) {
            console.log('Error occurred.');
            console.log(err);
        }
        
        // run again in 1 minute
        console.log('Waiting 1 minute...');
        setTimeout(runProcess, 60000);
    });
};

runProcess();
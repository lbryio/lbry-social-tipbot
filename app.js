const async = require('async');
const base58 = require('bs58check');
const config = require('./config/config');
const fs = require('fs');
const moment = require('moment');
const mysql = require('mysql');
const request = require('request');
const util = require('util');
if (config.debug) {
    require('request-debug')(request);
}

// URLS
const baseUrl = 'https://oauth.reddit.com';
const rateUrl = 'https://api.lbry.io/lbc/exchange_rate';
const tokenUrlFormat = 'https://%s:%s@www.reddit.com/api/v1/access_token';
const tipRegex = /(\$[\d\.]+|[\d\.]+( usd| lbc))/ig;
const gildRegex = new RegExp('gild (u|\/u)\/lbryian|(u|\/u)\/lbryian gild', 'ig');

// Other globals
const commentKind = 't1';
const privateMessageKind = 't4';
let globalAccessToken;
let accessTokenTime;

// Load message templates
const messageTemplates = {};
const templateNames = [
    'onbalance',
    'ondeposit',
    'ondeposit.completed',
    'ongild',
    'ongild.insufficientfunds',
    'onsendtip',
    'onsendtip.insufficientfunds',
    'onsendtip.invalidamount',
    'onwithdraw',
    'onwithdraw.amountltefee',
    'onwithdraw.insufficientfunds',
    'onwithdraw.invalidaddress',
    'onwithdraw.invalidamount'
];
for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    messageTemplates[name] = fs.readFileSync(`templates/${name}.txt`, { encoding: 'utf8' }); 
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

const loadAccessToken = (callback) => {
    if (fs.existsSync(config.accessTokenPath)) {
        const token = fs.readFileSync(config.accessTokenPath, { encoding: 'utf8' });
        return callback(null, String(token));
    }
    
    return callback(null, null);
};

const oauth = (callback) => {
    const url = util.format(tokenUrlFormat, config.clientId, config.clientSecret);
    request.post(url, { form: { grant_type: 'password', username: config.username, password: config.password} }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }

        let accessToken = null;
        try {
            const response = JSON.parse(body);
            accessToken = response.access_token;
            accessTokenTime = moment();
            if (accessToken && accessToken.trim().length > 0) {
                fs.writeFileSync(config.accessTokenPath, accessToken);
            }
        } catch (e) {
            return callback(e, null);
        }
        
        return callback(null, accessToken);
    });
};

const retrieveUnreadMessages = (accessToken, callback) => {
    const url = util.format('%s/message/unread?limit=100', baseUrl);
    request.get({ url: url, headers: { 'User-Agent': 'lbryian/1.0.0 Node.js (by /u/lbryian)', 'Authorization': 'Bearer ' + accessToken } }, (err, res, body) => {
         if (err) {
            console.log(err);
            return callback(err);
         }
         
         let response;
         try {
            response = JSON.parse(body);
         } catch (e) {
            return callback(e, null);
         }
         
         return callback(null, response.data.children);
    });
};

const createOrGetUserId = (username, callback) => {
    async.waterfall([
        (cb) => {
            db.query('SELECT Id FROM Users WHERE LOWER(Username) = ?', [username.toLowerCase()], cb);
        },
        (res, fields, cb) => {
            if (res.length === 0) {
                // user does not exist, create the user
                return cb(null, 0);
            }
            
            return cb(null, res[0].Id);
        },
        (userId, cb) => {
            if (userId === 0) {
                return db.query('INSERT INTO Users (Username, Created) VALUES (?, UTC_TIMESTAMP())', [username], (err, res) => {
                    if (err) {
                        console.log(err);
                        return cb(err, null);
                    }
                    
                    return cb(null, res.insertId);
                });
            }
            
            return cb(null, userId);
        }
    ], callback);
};

const processCompletedDeposits = (callback) => {
    const delay = 2000;
    async.waterfall([
        (cb) => {
            db.query('SELECT C.DepositId, D.Amount, U.Username, U.Balance FROM CompletedDepositConfirmations C JOIN Deposits D ON D.Id = C.DepositId JOIN Users U ON U.Id = C.UserId', cb);
        },
        (res, fields, cb) => {
            if (res.length > 0) {
                return async.eachSeries(res, (completedDeposit, ecb) => {
                    sendPMUsingTemplate('ondeposit.completed', { how_to_use_url: config.howToUseUrl, amount: completedDeposit.Amount, balance: completedDeposit.Balance },
                                        'Deposit completed!', completedDeposit.Username, (err) => {
                        if (err) {
                            return setTimeout(ecb, delay, err);
                        }
                        
                        // remove the entry from the DB
                        return db.query('DELETE FROM CompletedDepositConfirmations WHERE DepositId = ?', [completedDeposit.DepositId], (ierr) => {
                            if (ierr) {
                                return setTimeout(ecb, delay, ierr);
                            }
                            
                            // success
                            return setTimeout(ecb, delay, null, true);
                        });
                    });
                    // TODO: Implement inserting messages into a pending message queue instead
                }, (err) => {
                    if (err) {
                        return cb(err, null);
                    }
                    
                    return cb(null, true);
                });
            }
            
            return cb(null, true);
        }
    ], callback);
};

const getBalance = (userId, callback) => {
    db.query('SELECT Balance FROM Users WHERE Id = ?', [userId], (err, res) => {
        if (err) {
            return callback(err, null);
        }
        
        return callback(0, res.length === 0 ? 0 : res[0].Balance);
    });
};

const generateDepositAddress = (callback) => {
    request.post({ url: config.lbrycrd.rpcurl, json: { method: 'getnewaddress', params: [config.lbrycrd.account] } }, (err, resp, body) => {
        if (err || body.error) {
            return callback(err || body.error, null);
        }
        
        return callback(null, body.result);
    });
};

const getDepositAddress = (userId, callback) => {
    let newAddress = false;
    async.waterfall([
        (cb) => {
            db.query('SELECT DepositAddress FROM Users WHERE Id = ?', [userId], cb);
        },
        (res, fields, cb) => {
            const address = res.length > 0 ? res[0].DepositAddress : null;
            if (!address || address.trim().length === 0) {
                newAddress = true;
                return generateDepositAddress(cb);
            }
            return cb(null, address);
        },
        (address, cb) => {
            if (newAddress) {
                return db.query('UPDATE Users SET DepositAddress = ? WHERE Id = ?', [address, userId], (err) => {
                    if (err) {
                        return cb(err, null);
                    }
                    
                    return cb(null, address);
                });
            }
            
            return cb(null, address);
        }
    ], callback);
};

const sendTip = (sender, recipient, amount, tipdata, callback) => {
    console.log(`sending ${amount} LBC from ${sender} to ${recipient}`);
    
    const data = {};
    async.waterfall([
        (cb) => {
            // Start DB transaction
            db.beginTransaction((err) => {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, true);
            });
        },
        (started, cb) => {
            // start a transaction
            // check the sender's balance
            createOrGetUserId(sender, cb);
        },
        (senderId, cb) => {
            data.senderId = senderId;
            getBalance(senderId, cb);
        },
        (senderBalance, cb) => {
            // balance is less than amount to tip, or the difference after sending the tip is negative
            if (senderBalance < amount || (senderBalance - amount) < 0) {
                return sendPMUsingTemplate('onsendtip.insufficientfunds',
                                           {
                                                how_to_use_url: config.howToUseUrl,
                                                recipient: `u/${recipient}`,
                                                amount: amount,
                                                amount_usd: ['$', parseFloat(tipdata.amountUsd).toFixed(2)].join(''),
                                                balance: senderBalance
                                            }, 'Insufficient funds to send tip', tipdata.message.data.author, () => {
                    markMessageRead(tipdata.message.data.name, () => {
                        cb(new Error('Insufficient funds'), null);
                    });
                });
            }
            
            return db.query('UPDATE Users SET Balance = Balance - ? WHERE Id = ?', [amount, data.senderId], cb);
        },
        (res, fields, cb) => {
            // Update the recipient's balance
            createOrGetUserId(recipient, cb);
        },
        (recipientId, cb) => {
            data.recipientId = recipientId;
            db.query('UPDATE Users SET Balance = Balance + ? WHERE Id = ?', [amount, recipientId], cb);
        },
        (res, fields, cb) => {
            // save the message
            const msgdata = tipdata.message.data;
            db.query(   ['INSERT INTO Messages (AuthorId, Type, FullId, RedditId, ParentRedditId, Subreddit, Body, Context, RedditCreated, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'].join(''),
                        [data.senderId,
                         tipdata.message.kind === privateMessageKind ? 1 : 2,
                         msgdata.name,
                         msgdata.id,
                         msgdata.parent_id,
                         msgdata.subreddit,
                         msgdata.body,
                         msgdata.context,
                         moment.utc(msgdata.created_utc * 1000).format('YYYY-MM-DD HH:mm:ss')
                        ], cb);
        },
        (res, fields, cb) => {
            console.log('Inserting tip.');
            // save the tip information
            db.query(   ['INSERT INTO Tips (MessageId, SenderId, RecipientId, Amount, AmountUsd, ParsedAmount, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'].join(''),
                        [res.insertId,
                         data.senderId,
                         data.recipientId,
                         amount,
                         tipdata.amountUsd,
                         tipdata.parsedAmount,
                        ], cb);
        },
        (res, fields, cb) => {
            // reply to the source message with message template after successful commit
            const amountUsdStr = parseFloat(tipdata.amountUsd).toFixed(2);
            replyMessageUsingTemplate('onsendtip', { recipient: `u/${recipient}`, tip: `${amount} LBC ($${amountUsdStr})`, how_to_use_url: config.howToUseUrl},
                                      tipdata.message.data.name, cb);
        },
        (success, cb) => {
            // Mark the message as read
            markMessageRead(tipdata.message.data.name, cb);
        },
        (success, cb) => {
            // commit the transaction
            db.commit((err) => {
                if (err) {
                    return cb(err, null);
                }
                
                return cb(null, true);
            });
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return db.rollback(() => {
                callback(err, null);
            });
        }
        
        // success
        return callback(null, true);
    });
};

const convertUsdToLbc = (amount, callback) => {
    request.get({ url: rateUrl }, (err, res, body) => {
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        if (!response.data || !response.data.lbc_usd) {
            return callback(new Error('Could not retrieve the LBC/USD conversion rate.'));
        }
        
        const rateUsd = parseFloat(response.data.lbc_usd);
        if (isNaN(rateUsd) || rateUsd === 0) {
            return callback(new Error('Invalid LBC/USD rate retrieved.'));
        }
        const amountLbc = (amount / rateUsd).toFixed(8);
        return callback(null, amountLbc);
    });
};

const convertLbcToUsd = (amount, callback) => {
    request.get({ url: rateUrl }, (err, res, body) => {
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        if (!response.data || !response.data.lbc_usd) {
            return callback(new Error('Could not retrieve the LBC/USD conversion rate.'));
        }
        
        const rateUsd = parseFloat(response.data.lbc_usd);
        if (isNaN(rateUsd) || rateUsd === 0) {
            return callback(new Error('Invalid LBC/USD rate retrieved.'));
        }
        const amountLbc = (amount * rateUsd).toFixed(2);
        return callback(null, amountLbc);
    });
};

const gildThing = (thingFullId, callback) => {
    const url = `${baseUrl}/api/v1/gold/gild/${thingFullId}`;
    request.post({ url, headers: { 'User-Agent': config.userAgent, 'Authorization': 'Bearer ' + globalAccessToken } }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }
        
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            //return callback(e, null);
        }
        
        if (response && (response.json.ratelimit > 0 || response.json.errors.length > 0)) {
            return callback(new Error('Rate limited.'), null);
        }
        
        // success
        return callback(null, true);
    });
};

const markMessageRead = (messageFullId, callback) => {
    const url = `${baseUrl}/api/read_message`;
    request.post({ url, form: { id: messageFullId }, headers: { 'User-Agent': config.userAgent, 'Authorization': 'Bearer ' + globalAccessToken } }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }
        
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        // success
        return callback(null, true);
    });
};

const sendPMUsingTemplate = (template, substitutions, subject, recipient, callback) => {
    if (!messageTemplates[template]) {
        return callback(new Error(`Message template ${template} not found.`));
    }
    
    let messageText = messageTemplates[template];
    for (let variable in substitutions) {
        if (substitutions.hasOwnProperty(variable)) {
            const re = new RegExp(['{', variable, '}'].join(''), 'ig');
            messageText = messageText.replace(re, substitutions[variable]);
        }
    }
    
    // send the message
    const url = `${baseUrl}/api/compose`;
    request.post({
                    url,
                    form: { api_type: 'json', text: messageText, subject, to: recipient },
                    headers: { 'User-Agent': config.userAgent, 'Authorization': 'Bearer ' + globalAccessToken }
                 }, (err, res, body) => {
                    if (err) {
                        return callback(err, null);
                    }
                    
                    let response;
                    try {
                        response = JSON.parse(body);
                    } catch (e) {
                        return callback(e, null);
                    }
                    
                    if (response.json.ratelimit > 0 ||
                        response.json.errors.length > 0) {
                        return callback(new Error('Rate limited.'), null);
                    }
                    
                    // success
                    return callback(null, true);
                 });
};

const replyMessageUsingTemplate = (template, substitutions, sourceMessageFullId, callback) => {
    if (!messageTemplates[template]) {
        return callback(new Error(`Message template ${template} not found.`));
    }
    
    let messageText = messageTemplates[template];
    for (let variable in substitutions) {
        if (substitutions.hasOwnProperty(variable)) {
            const re = new RegExp(['{', variable, '}'].join(''), 'ig');
            messageText = messageText.replace(re, substitutions[variable]);
        }
    }
    
    // send the message
    const url = `${baseUrl}/api/comment`;
    request.post({
                    url,
                    form: { api_type: 'json', text: messageText, thing_id: sourceMessageFullId },
                    headers: { 'User-Agent': config.userAgent, 'Authorization': 'Bearer ' + globalAccessToken }
                 }, (err, res, body) => {
                    if (err) {
                        return callback(err, null);
                    }
                    
                    let response;
                    try {
                        response = JSON.parse(body);
                    } catch (e) {
                        return callback(e, null);
                    }
                    
                    if (response.json.ratelimit > 0 ||
                        response.json.errors.length > 0) {
                        return callback(new Error('Rate limited.'), null);
                    }
                    
                    // success
                    return callback(null, true);
                 });
};

const getMessageAuthor = (thingId, accessToken, callback) => {
    const url = util.format('%s/api/info?id=%s', baseUrl, thingId);
    request.get({ url: url, headers: { 'User-Agent': config.userAgent, 'Authorization': 'Bearer ' + globalAccessToken } }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }
        
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        return callback(null, (response.data.children.length > 0) ? response.data.children[0].data.author : null);
    });
};

const sendGild = (sender, recipient, amount, gilddata, callback) => {
    console.log(`gilding ${recipient} with ${amount} LBC worth ${gilddata.amountUsd} from ${sender}`);
    
    const data = {};
    async.waterfall([
        (cb) => {
            // Start DB transaction
            db.beginTransaction((err) => {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, true);
            });
        },
        (started, cb) => {
            // start a transaction
            // check the sender's balance
            createOrGetUserId(sender, cb);
        },
        (senderId, cb) => {
            data.senderId = senderId;
            getBalance(senderId, cb);
        },
        (senderBalance, cb) => {
            // balance is less than amount required for gilding, or the difference after sending the tip is negative
            if (senderBalance < amount || (senderBalance - amount) < 0) {
                return sendPMUsingTemplate('ongild.insufficientfunds',
                                           {
                                                how_to_use_url: config.howToUseUrl,
                                                recipient: `u/${recipient}`,
                                                amount: amount,
                                                amount_usd: ['$', parseFloat(gilddata.amountUsd).toFixed(2)].join(''),
                                                balance: senderBalance
                                            }, 'Insufficient funds', gilddata.message.data.author, () => {
                    markMessageRead(gilddata.message.data.name, () => {
                        cb(new Error('Insufficient funds'), null); 
                    });
                });
            }
            
            return db.query('UPDATE Users SET Balance = Balance - ? WHERE Id = ?', [amount, data.senderId], cb);
        },
        (res, fields, cb) => {
            createOrGetUserId(recipient, cb);
        },
        (recipientId, cb) => {
            data.recipientId = recipientId;
            
            // save the message
            const msgdata = gilddata.message.data;
            db.query(   ['INSERT INTO Messages (AuthorId, Type, FullId, RedditId, ParentRedditId, Subreddit, Body, Context, RedditCreated, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'].join(''),
                        [data.senderId,
                         gilddata.message.kind === privateMessageKind ? 1 : 2,
                         msgdata.name,
                         msgdata.id,
                         msgdata.parent_id,
                         msgdata.subreddit,
                         msgdata.body,
                         msgdata.context,
                         moment.utc(msgdata.created_utc * 1000).format('YYYY-MM-DD HH:mm:ss')
                        ], cb);
        },
        (res, fields, cb) => {
            // save the tip information
            db.query(   ['INSERT INTO Tips (MessageId, SenderId, RecipientId, Amount, AmountUsd, ParsedAmount, IsGild, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP())'].join(''),
                        [res.insertId,
                         data.senderId,
                         data.recipientId,
                         amount,
                         gilddata.amountUsd,
                         ['$', config.gildPrice.toFixed(2)].join(''),
                        ], cb);
        },
        (res, fields, cb) => {
            // send the gild
            gildThing(gilddata.message.data.parent_id, cb);
        },
        (success, cb) => {
            // reply to the source message with message template after successful commit
            const amountUsdStr = parseFloat(gilddata.amountUsd).toFixed(2);
            replyMessageUsingTemplate('ongild', { sender: `u/${sender}`, recipient: `u/${recipient}`, gild_amount: `${amount} LBC ($${amountUsdStr})`, how_to_use_url: config.howToUseUrl},
                                      gilddata.message.data.name, cb);
        },
        (success, cb) => {
            // Mark the message as read
            markMessageRead(gilddata.message.data.name, cb);
        },
        (success, cb) => {
            // commit the transaction
            db.commit((err) => {
                if (err) {
                    return cb(err, null);
                }
                
                return cb(null, true);
            });
        }
    ], (err) => {
        if (err) {
            return db.rollback(() => {
                callback(err, null);
            });
        }
        
        // success
        return callback(null, true);
    });
};

const doGild = function(message, callback) {
    async.waterfall([
        (cb) => {
            getMessageAuthor(message.data.parent_id, globalAccessToken, cb);
        },
        (recipient, cb) => {
            const sender = message.data.author;
            if (sender !== recipient) {
                return cb(null, { message, recipient, sender, amountUsd: config.gildPrice });
            }
            
            return cb(null, null);
        },
        (gilddata, cb) => {
            if (gilddata && gilddata.amountUsd > 0) {
                return convertUsdToLbc(gilddata.amountUsd, (err, convertedAmount) => {
                    if (err) {
                        return cb(err);
                    }
                    
                    gilddata.amountLbc = convertedAmount;
                    return cb(null, gilddata);
                });
            }
            return cb(null, null);
        },
        (data, cb) => {
            if (data) {
                return sendGild(data.sender, data.recipient, data.amountLbc, data, cb);
            }
            
            return cb(null, null);
        }
    ], callback);
};

const doSendTip = (body, message, callback) => {
    /**
     * accepted matched strings:
     * "1 usd" or "1 lbc" or "$1"
     */
    // Use regex matching
    let amountUsd = 0;
    let amountLbc = 0;
    let matchedString = '';
    const match = String(message.data.body).match(tipRegex);
    if (match && match.length > 0) {
        matchedString = match[0];
        if (matchedString.indexOf(' ') > -1) {
            const parts = matchedString.split(' ', 2);
            const amount = parseFloat(parts[0]);
            const unit = parts[1].toLowerCase();
            if (isNaN(amount) || amount <= 0 || ['usd', 'lbc'].indexOf(unit) === -1) {
                // invalid amount or unit
                return sendPMUsingTemplate('onsendtip.invalidamount', { how_to_use_url: config.howToUseUrl }, 'Invalid amount for send tip', message.data.author, () => {
                    markMessageRead(message.data.name, callback);
                });
            }
            
            if (unit === 'lbc') {
                amountLbc = amount;
            } else {
                amountUsd = amount;
            }
        } else {
            amountUsd = parseFloat(matchedString.substring(1));
            if (isNaN(amountUsd) || amountUsd <= 0) {
                return sendPMUsingTemplate('onsendtip.invalidamount', { how_to_use_url: config.howToUseUrl }, 'Invalid amount for send tip', message.data.author, () => {
                    markMessageRead(message.data.name, callback);
                });
            }
        }
    }
    
    if (amountLbc > 0 || amountUsd > 0) {
        const parsedAmount = matchedString;
        // get the author of the parent message
        return async.waterfall([
            (cb) => {
                getMessageAuthor(message.data.parent_id, globalAccessToken, cb);
            },
            (recipient, cb) => {
                const sender = message.data.author;
                if (sender !== recipient) {
                    return cb(null, { amountLbc, amountUsd, message, recipient, sender, parsedAmount });
                }
                
                return cb(null, null);
            },
            (tipdata, cb) => {
                if (tipdata) {
                    if (tipdata.amountUsd > 0) {
                        return convertUsdToLbc(tipdata.amountUsd, (err, convertedAmount) => {
                            if (err) {
                                return cb(err);
                            }
                            
                            tipdata.amountLbc = convertedAmount;
                            return cb(null, tipdata);
                        });
                    } else if (tipdata.amountLbc > 0 && (!tipdata.amountUsd || tipdata.amountUsd === 0)) {
                        return convertLbcToUsd(tipdata.amountLbc, (err, convertedAmount) => {
                            if (err) {
                                return cb(err);
                            }
                            
                            tipdata.amountUsd = convertedAmount;
                            return cb(null, tipdata);
                        });
                    }
                }

                return cb(null, null);    
            },
            (data, cb) => {
                if (data) {
                    return sendTip(data.sender, data.recipient, data.amountLbc, data, cb);
                }
                
                return cb(null, null);
            }
        ], callback);
    }
    
    // not a valid or recognised message, simply mark the message as read
    return markMessageRead(message.data.name, callback);
};

const doSendBalance = (message, callback) => {
    async.waterfall([
        (cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            getBalance(authorId, cb);
        },
        (balance, cb) => {
            // send message with balance
            replyMessageUsingTemplate('onbalance', { how_to_use_url: config.howToUseUrl, amount: balance }, message.data.name, cb);
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return callback(err, null);
        }
        
        // success
        return callback(null, true);
    });
};

const sendLbcToAddress = (address, amount, callback) => {
    request.post({ url: config.lbrycrd.rpcurl, json: { method: 'sendfrom', params: [config.lbrycrd.account, address, amount] } }, (err, resp, body) => {
        if (err || body.error) {
            return callback(err || body.error, null);
        }
        
        return callback(null, body.result);
    });  
};

const doWithdrawal = (amount, address, message, callback) => {
    const data = {};
    async.waterfall([
        (cb) => {
            // Start DB transaction
            db.beginTransaction((err) => {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, true);
            });
        },
        // prevent withdrawal to deposit address
        (started, cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            data.userId = authorId;
            getDepositAddress(authorId, cb);
        },
        (depositAddress, cb) => {
            if (address === depositAddress) {
                return cb(new Error('Attempt to withdraw to deposit address.'), null);
            }
            
            return getBalance(data.userId, cb);
        },
        (balance, cb) => {
            // check sufficient balance
            if (balance < amount || balance - amount < 0) {
                return sendPMUsingTemplate('onwithdraw.insufficientfunds', { how_to_use_url: config.howToUseUrl, amount: amount, balance: balance },
                                           'Insufficient funds for withdrawal', message.data.author, () => {
                    markMessageRead(message.data.name, () => {
                        cb(new Error('Insufficient funds'), null);
                    });
                });
            }
            
            // Update the balance
            db.query('UPDATE Users SET Balance = Balance - ? WHERE Id = ?', [amount, data.userId], cb);
        },
        (res, fields, cb) => {
            // Send the transaction on the blockchain
            sendLbcToAddress(address, amount, cb);
        },
        (txhash, cb) => {
            data.txhash = txhash;
            // Insert the withdrawal entry
            db.query('INSERT INTO Withdrawals (UserId, TxHash, Amount, Created) VALUES (?, ?, ?, UTC_TIMESTAMP())', [data.userId, txhash, amount], cb);
        },
        (res, fields, cb) => {
            // commit the transaction
            db.commit((err) => {
                if (err) {
                    return cb(err, null);
                }
                
                return cb(null, true);
            });
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        },
        (success, cb) => {
            // send a reply
            replyMessageUsingTemplate('onwithdraw', { how_to_use_url: config.howToUseUrl, address: address, amount: amount, txid: data.txhash }, message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return db.rollback(() => {
                callback(err, null);
            });
        }
        
        // success
        return callback(null, true);
    });
};

const doSendDepositAddress = (message, callback) => {
    async.waterfall([
        (cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            getDepositAddress(authorId, cb);
        },
        (address, cb) => {
            // send message with balance
            replyMessageUsingTemplate('ondeposit', { how_to_use_url: config.howToUseUrl, address: address }, message.data.name, cb);
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            return callback(err, null);
        }
        
        // success
        return callback(null, true);
    });
};

// Commands
// balance (PM)
// deposit (PM)
// tip (Comment): <amount> <unit> u/lbryian
// withdraw (PM): withdraw <amount> <address>
const processMessage = function(message, callback) {
    if (!message.kind || !message.data) {
        return callback(new Error('Invalid message specified for processing.'));
    }
    
    const body = String(message.data.body).trim();
    if (message.kind === privateMessageKind) {
        // balance, deposit or withdraw
        // Check the command
        if ('balance' === body.toLowerCase()) {
            // do balance check
            return doSendBalance(message, callback);
        } else if ('deposit' === body.toLowerCase()) {
            // send deposit address
            return doSendDepositAddress(message, callback);
        } else {
            // withdrawal
            const parts = body.split(' ');
            if (parts.length !== 3 ||
                parts[0].toLowerCase() !== 'withdraw') {
                // invalid message, ignore
                return callback(null, null);
            }
            
            const amount = parseFloat(parts[1]);
            if (isNaN(amount) || amount < 0) {
                // TODO: send a message that the withdrawal amount is invalid
                return sendPMUsingTemplate('onwithdraw.invalidamount', { how_to_use_url: config.howToUseUrl }, 'Invalid amount for withdrawal', message.data.author, () => {
                    markMessageRead(message.data.name, callback);
                });
            }
            
            if (amount <= config.lbrycrd.txfee) {
                return sendPMUsingTemplate('onwithdraw.amountltefee', { how_to_use_url: config.howToUseUrl, amount: amount, fee: config.lbrycrd.txfee },
                                           'Withdrawal amount less than minimum fee', message.data.author, () => {
                    markMessageRead(message.data.name, callback);
                });
            }
            
            // base58 check the address
            const address = parts[2];
            try {
                base58.decode(address);
            } catch(e) {
                return sendPMUsingTemplate('onwithdraw.invalidaddress', { how_to_use_url: config.howToUseUrl }, 'Invalid address for withdrawal', message.data.author, () => {
                    markMessageRead(message.data.name, callback);
                });
            }
            
            return doWithdrawal(amount, address, message, callback);
        }
        
        return callback(null, null);
    }
    
    if (message.kind === commentKind) {
        const gildMatch = body.match(gildRegex);
        if (gildMatch && gildMatch.length > 0) {
            doGild(message, callback);
        } else {
            doSendTip(body, message, callback);
        }
    }
};

// Run the bot
const runBot = () => {
    async.waterfall([
        (cb) => {
            if (!accessTokenTime || moment.duration(moment().diff(accessTokenTime)).asMinutes() >= 59) {
                // remove old or expired tokens
                // TODO: Implement refreshToken
                if (fs.existsSync(config.accessTokenPath)) {
                    fs.unlinkSync(config.accessTokenPath);
                }
            }
            
            return cb(null);
        },
        (cb) => {
            loadAccessToken(cb);  
        },
        (token, cb) => {
            if (!token || token.trim().length === 0) {
                return oauth(cb);
            }
            
            return cb(null, token);
        },
        (token, cb) => {
            globalAccessToken = token;
            processCompletedDeposits(cb);
        },
        (success, cb) => {
            retrieveUnreadMessages(globalAccessToken, cb);
        },
        (unread, cb) => {
            async.eachSeries(unread, (message, ecb) => {
                processMessage(message, ecb);    
            }, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
        }
        
        // Wait 1 minute for next iteration
        console.log('Waiting 1 minute...');
        setTimeout(runBot, 60000);
    });    
};
runBot();
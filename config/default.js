module.exports = {
    debug: true,
    accessTokenPath: 'token',
    clientId: '<CLIENT_ID>',
    clientSecret: '<CLIENT_SECRET>',
    username: '<USERNAME>',
    password: '<PASSWORD>',
    
    // for handling tip comments
    redditName: 'u/lbryian',
    
    mariadb: {
        host: 'localhost',
        username: '<DB_USERNAME>',
        password: '<DB_PASSWORD>',
        database: '<DB_NAME>'
    },
    
    lbrycrd: {
        account: 'tips',
        rpcurl: 'http://127.0.0.1:9245',
        txfee: 0.00002000
    }
};

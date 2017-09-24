CREATE TABLE Users
(
    `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `Username` VARCHAR(20) NOT NULL,
    `Balance` DECIMAL(18,8) UNSIGNED DEFAULT 0 NOT NULL,
    `DepositAddress` VARCHAR(34) CHARACTER SET latin1 COLLATE latin1_general_ci,
    `Created` DATETIME NOT NULL,
    PRIMARY KEY `PK_UserId` (`Id`),
    UNIQUE KEY `Idx_RedditUsername` (`Username`),
    UNIQUE KEY `Idx_UserDepositAddress` (`DepositAddress`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=4;

CREATE TABLE Messages
(
    `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `Type` SMALLINT NOT NULL COMMENT '1 - Private Message, 2 - Comment',
    `FullId` VARCHAR(15) CHARACTER SET latin1 COLLATE latin1_general_ci NOT NULL,
    `RedditId` VARCHAR(15) CHARACTER SET latin1 COLLATE latin1_general_ci NOT NULL,
    `ParentRedditId` VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_general_ci,
    `Subreddit` VARCHAR(50),
    `AuthorId` BIGINT UNSIGNED NOT NULL,
    `Body` TEXT,
    `Context` TEXT,
    `RedditCreated` DATETIME NOT NULL,
    `Created` DATETIME NOT NULL,
    PRIMARY KEY `PK_MessageId` (`Id`),
    FOREIGN KEY `FK_MessageAuthor` (`AuthorId`) REFERENCES `Users` (`Id`),
    UNIQUE KEY `Idx_MessageFullId` (`RedditFullId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=4;

CREATE TABLE Tips
(
    `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `MessageId` BIGINT UNSIGNED NOT NULL,
    `SenderId` BIGINT UNSIGNED NOT NULL,
    `RecipientId` BIGINT UNSIGNED NOT NULL,
    `ParsedAmount` VARCHAR(20) NOT NULL COMMENT 'user amount string, $0.x, 0.x usd or 0.x lbc',
    `AmountUsd` DECIMAL(18,2) UNSIGNED,
    `Amount` DECIMAL(18,8) UNSIGNED NOT NULL,
    `IsGild` TINYINT(1) DEFAULT 0 NOT NULL,
    `Created` DATETIME NOT NULL,
    PRIMARY KEY `PK_TipId` (`Id`),
    FOREIGN KEY `FK_TipSender` (`SenderId`) REFERENCES `Users` (`Id`),
    FOREIGN KEY `FK_TipRecipient` (`RecipientId`) REFERENCES `Users` (`Id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=4;

CREATE TABLE Deposits
(
    `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `UserId` BIGINT UNSIGNED NOT NULL,
    `TxHash` VARCHAR(70) CHARACTER SET latin1 COLLATE latin1_general_ci NOT NULL,
    `Amount` DECIMAL(18,8) UNSIGNED NOT NULL,
    `Confirmations` INTEGER UNSIGNED DEFAULT 0 NOT NULL COMMENT 'at least 3 confirmations required',
    `Created` DATETIME NOT NULL,
    PRIMARY KEY `PK_DepositId` (`Id`),
    FOREIGN KEY `FK_Depositor` (`UserId`) REFERENCES `Users` (`Id`),
    UNIQUE KEY `Idx_UserDepositTx` (`UserId`, `TxHash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=4;

CREATE TABLE Withdrawals
(
    `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `UserId` BIGINT UNSIGNED NOT NULL,
    `TxHash` VARCHAR(70) CHARACTER SET latin1 COLLATE latin1_general_ci NOT NULL,
    `Amount` DECIMAL(18,8) UNSIGNED NOT NULL,
    `Created` DATETIME NOT NULL,
    PRIMARY KEY `PK_DepositId` (`Id`),
    FOREIGN KEY `FK_Withdrawer` (`UserId`) REFERENCES `Users` (`Id`),
    UNIQUE KEY `Idx_WithdrawalTxHash` (`TxHash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=4;


DELIMITER //

CREATE TRIGGER `Trg_OnDepositCreated`
    AFTER INSERT ON `Deposits`
FOR EACH ROW
BEGIN
    IF NEW.Confirmations >= 3 THEN
        UPDATE Users U SET U.Balance = U.Balance + NEW.Amount WHERE U.Id = NEW.UserId;
    END IF;
END;

CREATE TRIGGER `Trg_OnDepositUpdated`
    AFTER UPDATE ON `Deposits`
FOR EACH ROW
BEGIN
    IF OLD.Confirmations < 3 AND NEW.Confirmations >= 3 THEN
        UPDATE Users U SET U.Balance = U.Balance + NEW.Amount WHERE U.Id = NEW.UserId;
    END IF;
END;
//

DELIMITER ;
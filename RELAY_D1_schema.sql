
-- Create table of lobbies
DROP TABLE IF EXISTS lobbies;
CREATE TABLE lobbies (
    code TEXT PRIMARY KEY ASC ON CONFLICT FAIL,
    last_updated DATETIME DEFAULT (unixepoch()),
    connected BOOLEAN DEFAULT TRUE,
    reconnect_code INTEGER DEFAULT (ABS(RANDOM()) % 65536)
);

-- Create table of banned codes
DROP TABLE IF EXISTS banned_codes;
CREATE TABLE banned_codes (
    code TEXT PRIMARY KEY ASC ON CONFLICT FAIL
);

-- Insert banned codes
INSERT INTO banned_codes (code) VALUES('FUCK');
INSERT INTO banned_codes (code) VALUES('DICK');
INSERT INTO banned_codes (code) VALUES('CUNT');

-- Create trigger to update the last updated time for a lobby
CREATE TRIGGER lobby_update
AFTER UPDATE ON lobbies
BEGIN
    UPDATE lobbies SET last_updated = unixepoch();
END;

-- Create trigger to prevent banned codes from being created
CREATE TRIGGER lobby_insert
BEFORE INSERT ON lobbies
WHEN EXISTS (SELECT 1 FROM banned_codes WHERE code = NEW.code)
BEGIN
    SELECT RAISE(ABORT, 'Blocked code selected') AS error_message;
END;

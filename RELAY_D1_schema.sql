
-- Create table of lobbies
DROP TABLE IF EXISTS lobbies;
CREATE TABLE lobbies (
    code TEXT PRIMARY KEY ASC ON CONFLICT FAIL,
    reconnect_code TEXT,
    connected BOOLEAN DEFAULT TRUE,
    last_updated DATETIME DEFAULT (unixepoch())
);

-- Create table of IP rate limiter buckets
DROP TABLE IF EXISTS buckets;
CREATE TABLE buckets (
    bucketid TEXT PRIMARY KEY,
    bucketstate TEXT
);

-- Create table of banned codes
DROP TABLE IF EXISTS banned_codes;
CREATE TABLE banned_codes (
    code TEXT PRIMARY KEY ASC ON CONFLICT FAIL
);

-- Insert banned codes
INSERT INTO banned_codes (code)
VALUES
    ('FUCK'),
    ('DICK'),
    ('CUNT'),
    ('SHIT'),
    ('CRAP'),
    ('CUCK'),
    ('COCK'),
    ('DAMN');

-- Create trigger to update the last updated time for a lobby
CREATE TRIGGER lobby_update
AFTER UPDATE ON lobbies
BEGIN
    UPDATE lobbies SET last_updated = unixepoch() WHERE code = NEW.code;
END;

-- Create trigger to prevent banned codes from being created
CREATE TRIGGER lobby_insert
BEFORE INSERT ON lobbies
WHEN EXISTS (SELECT 1 FROM banned_codes WHERE code = NEW.code)
BEGIN
    SELECT RAISE(ABORT, 'Blocked code selected') AS error_message;
END;

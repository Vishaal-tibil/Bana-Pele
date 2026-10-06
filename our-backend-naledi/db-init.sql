-- Local Docker only: runs once, when the naledi-db container first starts with
-- an empty volume. One database per service, as in the Azure plan. The apps
-- create their own tables on start (CREATE TABLE IF NOT EXISTS).
CREATE DATABASE naledi_bap;
CREATE DATABASE naledi_bpp;

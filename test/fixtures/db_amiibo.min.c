// A miniature stand-in for solosky/pixl.js fw/application/src/amiidb/db_amiibo.c.
// Hand-written: the real file is fetched into tools/.cache/, which is gitignored,
// so it cannot be a fixture. Every row here exists to pin one parser behaviour.

const db_amiibo_t db_amiibo[] = {
    // ordinary rows
    {0x00000000, 0x00000002, "Mario", "Super Smash Bros."},
    {0x00010000, 0x000c0002, "Luigi", "Super Smash Bros."},

    // an escaped quote inside the name
    {0x01810001, 0x00440502, "Isabelle \"Summer\"", "Animal Crossing"},

    // non-ASCII, to prove bytes are not assumed to be characters
    {0x1d000000, 0x04220002, "Tatsuhisa Kamijō", "Yu-Gi-Oh!"},

    // uppercase hex in the source must come out lowercase in the id
    {0x0ABC0000, 0x00DE0002, "Uppercase Hex", "Test"},

    // a name with a " - " tail, which is what abbreviate() acts on
    {0x0e010001, 0x02c20e02, "Pink Gold Peach - Horse Racing", "Mario Sports Superstars"},

    // malformed rows: one field short, and a missing brace. Both must be
    // skipped silently rather than throwing or producing a partial entry.
    {0x00020000, 0x00010002, "Missing Fourth Field"},
    {0x00030000, 0x00020002, "No Closing Brace", "x"

    // the last good row, proving parsing continues past the malformed ones
    {0x00040000, 0x00030002, "After The Mess", "Test"},
};

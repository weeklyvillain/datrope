# Migrations

Migrations run when a server starts. During an update the new server starts, and migrates,
while the previous release is still serving (deploy/README.md, "Updates"). So every migration
must work with the previous release's code (expand/contract):

- Expand: add tables, nullable columns, columns with defaults, indexes. Ship code that uses them.
- Contract, in a later release once no running code reads it: drop or rename columns, add
  NOT NULL, change types, delete rows. Put `-- datrope:contract` on its own line in that
  migration to tell the guard test (`../guard_test.go`) you checked.

A rename is an expand (add the new column, write both) then a contract (drop the old one).
Migrations up to 00042 predate the rule and are not checked.

-- A human may pin the order in which ready changes enter the lock; NULL means Clef decides.
ALTER TABLE tasks ADD COLUMN lock_order INTEGER;

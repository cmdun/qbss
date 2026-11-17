# Set up the question database

QBSS does not include question packets. On first launch, it asks you to choose either a folder that already contains `questions.sqlite` or a complete, extracted QBReader backup. QBSS checks the backup and converts it into a searchable database on your computer. No separate tools are needed.

Download a complete backup from [QBReader's database backup page](https://www.qbreader.org/db/backups). Extract the archive and keep all of its files together. In QBSS, select the folder containing `prelude.json`, `sets.bson`, `packets.bson`, `tossups.bson`, and `bonuses.bson`. Conversion can take several minutes and needs room for the new database while the backup is still present.

To replace or refresh a database later, open **Settings → Question database setup → Choose backup folder**. QBSS validates and imports the backup, then asks you to restart. Your stars, saved packets, and practice history are kept separately and remain in place.

Keep a private copy of your personal data if you want to preserve your progress. Do not publish it or include it when sharing a question database.

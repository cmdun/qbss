# QBSS — Quiz Bowl Study Suite

QBSS is a desktop app for practicing quiz bowl questions, exploring topics in Wikipedia, and making Anki cards. It runs locally on your computer. It is an independent project based in part on [QBReader](https://github.com/qbreader/website), not the official QBReader service.

## Install

Prebuilt installers are published on the [QBSS Releases page](https://github.com/cmdun/qbss/releases) as platform builds become available. Use the installer listed for your computer:

- **macOS:** Open the `.dmg` file and drag **QBSS** into **Applications**. Open QBSS from Applications.
- **Windows:** Open the `QBSS-1.0.0-windows-x64.exe` installer and follow the installation steps. Start QBSS from the Start menu or desktop shortcut.

QBSS 1.0.0 is unsigned. macOS or Windows may show a security notice the first time you open it. Only install a copy downloaded from the QBSS Releases page.

## First launch

QBSS does not include question packets. On first launch, choose either an existing `questions.sqlite` database or the folder containing your complete, extracted QBReader database backup. QBSS converts a backup into a searchable database on your computer. This can take a few minutes. See [Database setup](DATABASE_SETUP.md) for where to get a backup and more details.

Your stars, saved packets, and practice history are stored separately from the question database. They remain on your computer. QBSS does not upload your questions or personal statistics.

To import QBReader statistics, open **Settings → Import QBReader stats** and select either or both of the tossup and bonus CSV files.

## Optional connections

- **Anki:** Install Anki and the AnkiConnect add-on separately. QBSS can then add cards directly to your collection.
- **Wikipedia:** The built-in reader searches English Wikipedia when you have an internet connection. Article content follows Wikipedia's attribution and license terms.

## Privacy and content

The software is shared under the [MIT License](LICENSE). QBSS includes adapted QBReader code under its original [MIT License](qbreader-source/LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for other included software.

Question packets and database backups have their own rights and are not included with QBSS. Download and use them only in ways permitted by their providers. Do not redistribute a question database unless you have permission.

QBSS sends Wikipedia requests with an identifying application name and a link to this project, following [Wikimedia's API usage guidance](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy). AnkiConnect runs separately on your computer; QBSS does not include it.

## Help

For setup help, feature requests, or bug reports, visit [QBSS on GitHub](https://github.com/cmdun/qbss).

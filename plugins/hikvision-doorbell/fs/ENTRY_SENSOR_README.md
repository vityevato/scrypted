# Entry Sensor Interface

This device serves as a companion for the Hikvision Doorbell device. It provides an interface for monitoring the door/window opening state, which is integrated into models such as the DS-KV6113.
In the settings section, you can see the linked (parent) device, as well as the IP address of the Hikvision Doorbell (physical device). These fields are not editable, they are for information purposes only.

The Entry Sensor monitors the door opening state and reports:
- **Closed** (entryOpen: false) - Door/window is closed
- **Open** (entryOpen: true) - Door/window is open
- **Jammed** (entryOpen: 'jammed') - Door/window mechanism is stuck or malfunctioning

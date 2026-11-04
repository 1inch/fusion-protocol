
## IOrderRegistrator

The announcement surface of the order registrator that anchored schedules read.

### Functions list
- [announcedAt(orderHash) external](#announcedat)

### Functions
### announcedAt

```solidity
function announcedAt(bytes32 orderHash) external view returns (uint256 timestamp)
```
Returns the time an order was first registered, or zero when it never was.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| orderHash | bytes32 | The hash of the order. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
timestamp | uint256 | The block timestamp of the first registration. |



## FusionTwap

Executes one signed Fusion order as a TWAP: the order unlocks in equal parts, one per interval, every
part is sold through a fresh run of the settlement's Dutch auction, and nothing is fillable after the last interval.

_The order extension references this contract three times, and the contract keeps no storage:
- as the pre-interaction, whose data is the schedule, it caps the cumulative filled amount by the parts
  unlocked so far, measured with the remaining amount the limit order protocol tracks for the order;
- as both amount getters, placed in front of the settlement's getter, it restarts the settlement's auction at
  the start of the current part by rewriting the auction start time it forwards.
The getters read the schedule from the pre-interaction and the pre-interaction checks that both getters route
here, so an order that misses any of the three references cannot be filled.
A part that is not filled within its own interval stays unlocked and is sold on the current part's auction, at
whatever point that curve has reached. An auction shorter than the interval leaves the price at the limit until
the next part starts, so the auction duration should equal the interval._

### Functions list
- [constructor(orderRegistrator) public](#constructor)
- [preInteraction(order, extension, orderHash, , makingAmount, , remainingMakingAmount, extraData) external](#preinteraction)
- [getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, extraData) external](#getmakingamount)
- [getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, extraData) external](#gettakingamount)

### Errors list
- [TwapNotStarted() ](#twapnotstarted)
- [TwapEnded() ](#twapended)
- [TwapNotAnnounced() ](#twapnotannounced)
- [TwapScheduleNotFound() ](#twapschedulenotfound)
- [TwapRequiresMultipleFills() ](#twaprequiresmultiplefills)
- [TwapInvalidSchedule() ](#twapinvalidschedule)
- [TwapInvalidAuctionDetails() ](#twapinvalidauctiondetails)
- [TwapAmountNotUnlocked(filledAmount, unlockedAmount) ](#twapamountnotunlocked)

### Functions
### constructor

```solidity
constructor(contract IOrderRegistrator orderRegistrator) public
```

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| orderRegistrator | contract IOrderRegistrator | The registrator whose announcements anchored schedules start from, or the zero address where none is deployed. |

### preInteraction

```solidity
function preInteraction(struct IOrderMixin.Order order, bytes extension, bytes32 orderHash, address, uint256 makingAmount, uint256, uint256 remainingMakingAmount, bytes extraData) external view
```
See {IPreInteraction-preInteraction}.

_Reverts unless both amount getters route to this contract and the fill keeps the order within its
unlocked parts. It moves no funds and writes no state, so it is safe for anyone to call.
`extraData` is the schedule:
```
4 bytes - start time of the first part; with the top bit set, the start is the later of the remaining
          bits and the order's announcement at the order registrator
3 bytes - interval between parts, in seconds
2 bytes - number of parts
```_

### getMakingAmount

```solidity
function getMakingAmount(struct IOrderMixin.Order order, bytes extension, bytes32 orderHash, address taker, uint256 takingAmount, uint256 remainingMakingAmount, bytes extraData) external view returns (uint256)
```
See {IAmountGetter-getMakingAmount}.

_`extraData` is the next amount getter's address followed by its data, which must start with the
settlement's `AuctionDetails`. The auction start time in it is replaced with the current part's start._

### getTakingAmount

```solidity
function getTakingAmount(struct IOrderMixin.Order order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) external view returns (uint256)
```
See {IAmountGetter-getTakingAmount}.

_`extraData` has the same format as in {getMakingAmount}._

### Errors
### TwapNotStarted

```solidity
error TwapNotStarted()
```

### TwapEnded

```solidity
error TwapEnded()
```

### TwapNotAnnounced

```solidity
error TwapNotAnnounced()
```

### TwapScheduleNotFound

```solidity
error TwapScheduleNotFound()
```

### TwapRequiresMultipleFills

```solidity
error TwapRequiresMultipleFills()
```

### TwapInvalidSchedule

```solidity
error TwapInvalidSchedule()
```

### TwapInvalidAuctionDetails

```solidity
error TwapInvalidAuctionDetails()
```

### TwapAmountNotUnlocked

```solidity
error TwapAmountNotUnlocked(uint256 filledAmount, uint256 unlockedAmount)
```


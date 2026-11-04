
## FusionTwap

Executes one signed Fusion order as a TWAP: the order unlocks in equal parts, one per interval,
and every part is sold through a fresh run of the settlement's Dutch auction.

_The order extension references this contract twice, and the contract keeps no storage:
- as the pre-interaction, whose data is the schedule, it caps the cumulative filled amount by the parts
  unlocked so far, measured with the remaining amount the limit order protocol tracks for the order;
- as the amount getter placed in front of the settlement's getter, it restarts the settlement's auction at
  the start of the current part by rewriting the auction start time it forwards.
Both roles read the schedule from the pre-interaction, so pricing and enforcement cannot disagree.
A part that is not filled within its own interval stays unlocked and is sold on a later part's auction._

### Functions list
- [preInteraction(order, , , , makingAmount, , remainingMakingAmount, extraData) external](#preinteraction)
- [getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, extraData) external](#getmakingamount)
- [getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, extraData) external](#gettakingamount)

### Errors list
- [TwapNotStarted() ](#twapnotstarted)
- [TwapScheduleNotFound() ](#twapschedulenotfound)
- [TwapRequiresMultipleFills() ](#twaprequiresmultiplefills)
- [TwapInvalidSchedule() ](#twapinvalidschedule)
- [TwapInvalidAuctionDetails() ](#twapinvalidauctiondetails)
- [TwapAmountNotUnlocked(filledAmount, unlockedAmount) ](#twapamountnotunlocked)
- [TwapFillTooLarge(makingAmount, maxFillAmount) ](#twapfilltoolarge)

### Functions
### preInteraction

```solidity
function preInteraction(struct IOrderMixin.Order order, bytes, bytes32, address, uint256 makingAmount, uint256, uint256 remainingMakingAmount, bytes extraData) external view
```
See {IPreInteraction-preInteraction}.

_Reverts unless the fill keeps the order within its unlocked parts. It moves no funds and writes
no state, so it is safe for anyone to call. `extraData` is the schedule:
```
4 bytes - start time of the first part
3 bytes - interval between parts, in seconds
2 bytes - number of parts
1 byte  - maximum number of parts a single fill may take, 0 for no limit
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

### TwapFillTooLarge

```solidity
error TwapFillTooLarge(uint256 makingAmount, uint256 maxFillAmount)
```


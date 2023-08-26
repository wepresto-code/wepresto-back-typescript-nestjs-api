import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { RabbitRPC } from '@golevelup/nestjs-rabbitmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import appConfig from '../../../../config/app.config';

import { Loan, LoanStatus } from '../loan.entity';
import { MovementType } from '../../movement/movement.entity';

import { LoanReadService } from './loan.read.service';
import { WeprestoSlackService } from '../../../../plugins/wepresto-slack/wepresto-slack.service';
import { EventMessageService } from '../../../event-message/event-message.service';
import { NotificationService } from '../../../notification/notification.service';
import { FrenchAmortizationSystemService } from '../../french-amortization-system/french-amortization-system.service';
import { LenderService } from '../../../users/lender/services/lender.service';

import {
  getNumberOfDays,
  getRabbitMQExchangeName,
  formatDate,
  getReferenceDate,
} from '../../../../utils';

const RABBITMQ_EXCHANGE = getRabbitMQExchangeName();

@Injectable()
export class LoanConsumerService {
  constructor(
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
    @InjectRepository(Loan)
    private readonly loanRepository: Repository<Loan>,
    private readonly readService: LoanReadService,
    private readonly weprestoSlackService: WeprestoSlackService,
    private readonly eventMessageService: EventMessageService,
    private readonly notificationService: NotificationService,
    private readonly frenchAmortizationSystemService: FrenchAmortizationSystemService,
    private readonly lenderService: LenderService,
  ) {}

  @RabbitRPC({
    exchange: RABBITMQ_EXCHANGE,
    routingKey: `${RABBITMQ_EXCHANGE}.loan_disbursement`,
    queue: `${RABBITMQ_EXCHANGE}.${LoanConsumerService.name}.loan_disbursement`,
  })
  public async loanDisbursementConsumer(input: any) {
    const eventMessage = await this.eventMessageService.create({
      routingKey: `${RABBITMQ_EXCHANGE}.loan_disbursement`,
      functionName: 'loanDisbursementConsumer',
      data: input,
    });

    try {
      const { loanUid } = input;

      Logger.log(
        `loan ${loanUid} received`,
        LoanConsumerService.name + '.loanDisbursementConsumer',
      );

      // get the loan
      const existingLoan = await this.readService.getOne({
        uid: loanUid,
      });

      // get the loan installments
      const loanInstallments =
        this.frenchAmortizationSystemService.getLoanInstallments({
          amount: existingLoan.amount,
          annualInterestRate: existingLoan.annualInterestRate,
          term: existingLoan.term,
          referenceDate: existingLoan.startDate,
        });

      // eslint-disable-next-line no-console
      // console.table(loanInstallments);

      // create the loan installments movements
      const preloadedLoan = await this.loanRepository.preload({
        id: existingLoan.id,
        movements: loanInstallments.map((loanInstallment) => ({
          type: MovementType.LOAN_INSTALLMENT,
          amount: loanInstallment.amount,
          interest: loanInstallment.interest,
          principal: loanInstallment.principal,
          balance: loanInstallment.balance,
          dueDate: loanInstallment.dueDate,
          paid: false,
        })),
      });

      // save the loan with the movements
      await this.loanRepository.save(preloadedLoan);

      Logger.log(
        `loan ${loanUid} disbursement completed`,
        LoanConsumerService.name + '.loanDisbursementConsumer',
      );
    } catch (error) {
      console.error(error);

      const message = error.message;

      await this.eventMessageService.setError({
        id: eventMessage._id,
        error,
      });

      return {
        status: error.status || 500,
        message,
        data: {},
      };
    }
  }

  @RabbitRPC({
    exchange: RABBITMQ_EXCHANGE,
    routingKey: `${RABBITMQ_EXCHANGE}.loan_application`,
    queue: `${RABBITMQ_EXCHANGE}.${LoanConsumerService.name}.loan_application`,
  })
  public async loanApplicationConsumer(input: any) {
    const eventMessage = await this.eventMessageService.create({
      routingKey: `${RABBITMQ_EXCHANGE}.loan_application`,
      functionName: 'loanApplicationConsumer',
      data: input,
    });

    try {
      const { loanUid } = input;

      Logger.log(
        `loan ${loanUid} received`,
        LoanConsumerService.name + '.loanApplicationConsumer',
      );

      // get the loan
      const existingLoan = await this.loanRepository
        .createQueryBuilder('loan')
        .innerJoinAndSelect('loan.borrower', 'borrower')
        .innerJoinAndSelect('borrower.user', 'user')
        .where('loan.uid = :loanUid', { loanUid })
        .getOne();

      // send the message
      await this.weprestoSlackService.sendNewLoanApplicationMessage({
        loan: existingLoan,
      });
    } catch (error) {
      console.error(error);

      const message = error.message;

      await this.eventMessageService.setError({
        id: eventMessage._id,
        error,
      });

      return {
        status: error.status || 500,
        message,
        data: {},
      };
    }
  }

  @RabbitRPC({
    exchange: RABBITMQ_EXCHANGE,
    routingKey: `${RABBITMQ_EXCHANGE}.send_early_payment_notifications`,
    queue: `${RABBITMQ_EXCHANGE}.${LoanConsumerService.name}.send_early_payment_notifications`,
  })
  public async sendEarlyPaymentNotificationsConsumer(input: any) {
    const {
      app: { selftWebUrl },
    } = this.appConfiguration;

    const eventMessage = await this.eventMessageService.create({
      routingKey: `${RABBITMQ_EXCHANGE}.send_early_payment_notifications`,
      functionName: 'sendEarlyPaymentNotificationsConsumer',
      data: input || {},
    });

    try {
      // get the loans that are DISBURSED with them movements
      const loans = await this.loanRepository
        .createQueryBuilder('loan')
        .innerJoinAndSelect('loan.borrower', 'borrower')
        .innerJoinAndSelect('borrower.user', 'user')
        .innerJoinAndSelect('loan.movements', 'movement')
        .where('loan.status = :status', { status: LoanStatus.DISBURSED })
        .getMany();

      // filter the loans that are up to date
      const filteredLoans = loans.filter((loan) => {
        const overdueInterestMovement = loan.movements.find((movement) => {
          return (
            movement.type === MovementType.OVERDUE_INTEREST && !movement.paid
          );
        });

        return !overdueInterestMovement;
      });

      // iterate over the loans
      for (const loan of filteredLoans) {
        // get the first movement with the type LOAN_INSTALLMENT is not paid
        const firstUnpaidLoanInstallment = loan.movements.find((movement) => {
          return (
            movement.type === MovementType.LOAN_INSTALLMENT && !movement.paid
          );
        });

        // get the difference in days between the due date and the current date
        const { dueDate } = firstUnpaidLoanInstallment;

        // calculate the number of days
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);
        const numberOfDays = getNumberOfDays(currentDate, dueDate);

        // depending on the number of days send the notification
        switch (numberOfDays) {
          case 10:
            await this.notificationService.sendEarlyPaymentNotificationA({
              email: loan.borrower.user.email,
              firstName: loan.borrower.user.fullName.split(' ')[0],
              alias: loan.alias || '' + loan.id,
              dueDate: formatDate(dueDate, 'UTC'),
            });
            break;
          case 3:
            await this.notificationService.sendEarlyPaymentNotificationB({
              email: loan.borrower.user.email,
              firstName: loan.borrower.user.fullName.split(' ')[0],
              alias: loan.alias || '' + loan.id,
              link: `${selftWebUrl}/borrower/loans`,
            });
            break;
          case 0:
            await this.notificationService.sendEarlyPaymentNotificationC({
              email: loan.borrower.user.email,
              phoneNumber: `+57${loan.borrower.user.phoneNumber}`,
              firstName: loan.borrower.user.fullName.split(' ')[0],
              alias: loan.alias || '' + loan.id,
              link: `${selftWebUrl}/borrower/loans`,
            });
            break;
          default:
            Logger.log(
              `number of days to due date ${numberOfDays}, loan ${loan.uid} has no early payment notification to send`,
              LoanConsumerService.name +
                '.sendEarlyPaymentNotificationsConsumer',
            );
            break;
        }
      }
    } catch (error) {
      const message = error.message;

      await this.eventMessageService.setError({
        id: eventMessage._id,
        error,
      });

      return {
        status: error.status || 500,
        message,
        data: {},
      };
    }
  }

  @RabbitRPC({
    exchange: RABBITMQ_EXCHANGE,
    routingKey: `${RABBITMQ_EXCHANGE}.send_late_payment_notifications`,
    queue: `${RABBITMQ_EXCHANGE}.${LoanConsumerService.name}.send_late_payment_notifications`,
  })
  public async sendLatePaymentNotificationsConsumer(input: any) {
    const {
      app: { selftWebUrl },
    } = this.appConfiguration;

    Logger.log(
      'started',
      LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
    );

    const eventMessage = await this.eventMessageService.create({
      routingKey: `${RABBITMQ_EXCHANGE}.send_late_payment_notifications`,
      functionName: 'sendLatePaymentNotificationsConsumer',
      data: input || {},
    });

    try {
      // get the loans that are in overdue
      const loans = await this.loanRepository
        .createQueryBuilder('loan')
        .innerJoinAndSelect('loan.borrower', 'borrower')
        .innerJoinAndSelect('borrower.user', 'user')
        .innerJoinAndSelect('loan.movements', 'movement')
        .where('loan.status = :status', { status: LoanStatus.DISBURSED })
        .getMany();

      // filter the loans that are in overdue
      const filteredLoans = loans.filter((loan) => {
        const overdueInterestMovement = loan.movements.find((movement) => {
          return (
            movement.type === MovementType.OVERDUE_INTEREST && !movement.paid
          );
        });

        return overdueInterestMovement;
      });

      if (!filteredLoans.length) {
        Logger.log(
          'there are no loans in overdue',
          LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
        );
        return;
      }

      // iterate over the loans
      for (const loan of filteredLoans) {
        // get the first loan installment that is overdue
        const firstUnpaidLoanInstallment = loan.movements.find((movement) => {
          return (
            movement.type === MovementType.LOAN_INSTALLMENT && !movement.paid
          );
        });

        // get the difference in days between the due date and the current date
        const { dueDate } = firstUnpaidLoanInstallment;

        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);

        const numberOfDays = getNumberOfDays(dueDate, currentDate);

        if (numberOfDays === 1) {
          Logger.log(
            `sending notification A to loan ${loan.uid}`,
            LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
          );
          await this.notificationService.sendLatePaymentNotificationA({
            email: loan.borrower.user.email,
            phoneNumber: `+57${loan.borrower.user.phoneNumber}`,
            firstName: loan.borrower.user.fullName.split(' ')[0],
            link: `${selftWebUrl}/borrower/loans`,
          });
        } else if (numberOfDays === 3) {
          Logger.log(
            `sending notification B to loan ${loan.uid}`,
            LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
          );

          await this.notificationService.sendLatePaymentNotificationB({
            email: loan.borrower.user.email,
            phoneNumber: `+57${loan.borrower.user.phoneNumber}`,
            firstName: loan.borrower.user.fullName.split(' ')[0],
            link: `${selftWebUrl}/borrower/loans`,
          });
        } else if (numberOfDays === 5) {
          Logger.log(
            `sending notification C to loan ${loan.uid}`,
            LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
          );

          await this.notificationService.sendLatePaymentNotificationC({
            email: loan.borrower.user.email,
            phoneNumber: `+57${loan.borrower.user.phoneNumber}`,
            firstName: loan.borrower.user.fullName.split(' ')[0],
            link: `${selftWebUrl}/borrower/loans`,
          });
        } else if (numberOfDays > 5) {
          Logger.log(
            `sending slack message to start collection management to loan ${loan.uid}`,
            LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
          );

          await this.weprestoSlackService.sendStartCollectionManagement({
            loan: {
              ...loan,
              dueDate: formatDate(dueDate),
              minimumPaymentAmount: (
                await this.readService.getMinimumPaymentAmount({
                  uid: loan.uid,
                  referenceDate: getReferenceDate(new Date()),
                })
              ).totalAmount,
            },
          });
        } else {
          Logger.log(
            `number of days in due date: ${numberOfDays}, loan: ${loan.uid} has no late payment notification to send`,
            LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
          );
        }
      }
    } catch (error) {
      console.error(error);

      const message = error.message;

      await this.eventMessageService.setError({
        id: eventMessage._id,
        error,
      });

      return {
        status: error.status || 500,
        message,
        data: {},
      };
    } finally {
      Logger.log(
        `completed`,
        LoanConsumerService.name + '.sendLatePaymentNotificationsConsumer',
      );
    }
  }

  @RabbitRPC({
    exchange: RABBITMQ_EXCHANGE,
    routingKey: `${RABBITMQ_EXCHANGE}.loan_in_funding`,
    queue: `${RABBITMQ_EXCHANGE}.${LoanConsumerService.name}.`,
  })
  public async loanInFundingConsumer(input: any) {
    const {
      environment,
      app: { selftWebUrl },
    } = this.appConfiguration;

    if (environment === 'local') {
      Logger.log(
        'skipped because environment is local',
        LoanConsumerService.name + '.loanInFundingConsumer',
      );
      return;
    }

    Logger.log('started', LoanConsumerService.name + '.loanInFundingConsumer');

    const eventMessage = await this.eventMessageService.create({
      routingKey: `${RABBITMQ_EXCHANGE}.loan_in_funding`,
      functionName: 'loanInFundingConsumer',
      data: input || {},
    });

    try {
      const { loanUid } = input;

      Logger.log(
        `loan ${loanUid} received`,
        LoanConsumerService.name + '.loanInFundingConsumer',
      );

      const [{ borrower }, { lenders }] = await Promise.all([
        // get borrower
        this.loanRepository
          .createQueryBuilder('loan')
          .innerJoinAndSelect('loan.borrower', 'borrower')
          .innerJoinAndSelect('borrower.user', 'user')
          .where('loan.uid = :uid', { uid: loanUid })
          .getOne(),
        // get lenders
        this.lenderService.readService.getMany({
          take: '' + 1000 * 1000,
        }),
      ]);

      // sending the the notifications
      Promise.all([
        // sending loan in funding notification to borrower
        this.notificationService.sendLoanInFundingNotification({
          phoneNumber: `+57${borrower.user.phoneNumber}`,
          firstName: borrower.user.fullName.split(' ')[0],
        }),
        // sending new investment notification to each lender
        ...lenders.map(async (lender) => {
          Logger.log(
            `sending new investment notification to lender ${lender.uid}`,
            LoanConsumerService.name + '.loanInFundingConsumer',
          );

          await this.notificationService.sendNewInvestmentOpportunityNotification(
            {
              email: lender.user.email,
              phoneNumber: `+57${lender.user.phoneNumber}`,
              firstName: lender.user.fullName.split(' ')[0],
              loanUid,
              link: `${selftWebUrl}/lender/opportunities`,
            },
          );
        }),
      ]);
    } catch (error) {
      console.error(error);

      const message = error.message;

      await this.eventMessageService.setError({
        id: eventMessage._id,
        error,
      });

      return {
        status: error.status || 500,
        message,
        data: {},
      };
    } finally {
      Logger.log(
        `completed`,
        LoanConsumerService.name + '.loanInFundingConsumer',
      );
    }
  }
}

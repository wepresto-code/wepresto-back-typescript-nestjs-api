import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  // OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Lender } from './lender.entity';

// import { Loan } from '../loan/loan.entity';
// import { LoanRequest } from '../loan-request/loan-request.entity';

@Entity({ name: 'user' })
@Unique('uk_user_auth_uid', ['authUid'])
export class User extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'auth_uid', type: 'varchar', length: 100, nullable: true })
  authUid?: string;

  @Column({
    name: 'document_number',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  documentNumber?: string;

  @Column({ name: 'full_name', type: 'varchar', length: 160, nullable: true })
  fullName?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  email?: string;

  @Column({ name: 'phone_number', type: 'varchar', length: 13, nullable: true })
  phoneNumber?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  address?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // relations

  @OneToOne(() => Lender, (lender) => lender.user, { cascade: true })
  lender: Lender;

  /*
  @OneToMany(() => Loan, (loan) => loan.user)
  loans: Loan[];
  */

  /*
  @OneToMany(() => Loan, (loan) => loan.user)
  loanRequests: LoanRequest[];
  */
}
